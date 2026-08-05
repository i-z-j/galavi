/**
 * TiledImageLayer — shared base for pyramid-backed tiled image layers
 * (VolumeLayer: 3D chunks, SliceLayer: 2D planes).
 *
 * Owns everything the two layers do identically: source/selection state and
 * versioning, declarative source-descriptor resolution (`Data.source` via
 * `sourceRegistry`), the tile-residency spec, and the per-frame plan flow
 * (level pick → chunk enumeration → params sync → loader). The genuine
 * dimensional differences stay in the concrete layer as small hooks:
 * level-selection axes, slot-size computation, level-grid projection,
 * tile metadata, fetch-position mapping, and viewport/grid params arity.
 */

import type {
  Data,
  ImagePyramid,
  ImagePyramidLevel,
  LayerConfig,
  SourceDescriptor,
  Vec3,
} from "../types";
import {
  buildTileFetcher,
  optBoolean,
  pickPyramidLevel,
  planTiles,
  sourceChanged,
  type AxisIndex,
  type TileFramePlan,
  type TilePlacement,
  type TilePlan,
  type TileSpec,
  type TileViewport,
} from "../utils";
import {
  sourceRegistry,
  type ResolvedSource,
} from "../registry";
import { BaseLayer } from "./base";

/** Options shared by every tiled image layer. */
export interface TiledImageOptions {
  /** Data source descriptor */
  source?      : Data;
  /** Optional tile-atlas slot cap (default: derived from a 128 MiB budget) */
  maxPoolSize? : number;
  /** Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into urlTemplate or passed to source.fetch. */
  selection?   : Record<string, number>;
  /** Optional normalized XYZ crop. Storage requests still snap to whole chunks. */
  region?      : { min: Vec3; max: Vec3 };
  /** Keep the coarse-first initial frame, then always refine to level 0. */
  finestLevel? : boolean;
}

/** Pyramid-level context handed to the per-frame planning hooks. */
export interface TileLevelContext {
  pyramid   : ImagePyramid;
  level     : number;
  levelInfo : ImagePyramidLevel;
}

/** Storage-chunk grid for one pyramid level, in the layer's rendered axes. */
export interface TileLevelGrid {
  gridDim   : 2 | 3;
  chunkSize : number[];
  resSize   : number[];
}

export abstract class TiledImageLayer extends BaseLayer {
  protected source?      : Data;
  protected maxPoolSize? : number;
  protected selection    : Record<string, number>;
  private region?        : { min: Vec3; max: Vec3 };
  private finestLevel    = false;

  /**
   * Runtime artifacts resolved from `source.source` via `sourceRegistry`.
   * Never written back into `State` — the descriptor stays the canonical,
   * JSON-serializable form of the source.
   */
  private resolvedSource? : ResolvedSource;
  /** Monotonic token invalidating superseded async resolutions. */
  private sourceEpoch     = 0;

  private currentLevel : number;

  constructor(id?: string, config?: TiledImageOptions) {
    super(id);
    this.source       = config?.source;
    this.maxPoolSize  = config?.maxPoolSize;
    this.selection    = config?.selection ? { ...config.selection } : {};
    this.region       = readRegion(config?.region);
    this.finestLevel  = config?.finestLevel === true;
    this.currentLevel = Math.max(0, (this.source?.pyramid?.levels.length ?? 1) - 1);
    this.resolveSourceDescriptor();
  }

  // === Dimensional hooks (the real 2D/3D differences) ===

  /** Debug label prefix for the tile pool (e.g. "VolumeLayer"). */
  protected abstract get tileLabel(): string;
  /** World axes used for automatic level selection ([0,1,2] volume, [u,v] slice). */
  protected abstract get levelAxes(): readonly AxisIndex[];
  /** Tile-atlas slot size: max chunk extents across levels, in rendered axes. */
  protected abstract slotSize(pyramid: ImagePyramid): Vec3;
  /** Storage-chunk grid for a level, projected onto the rendered axes. */
  protected abstract levelGrid(ctx: TileLevelContext): TileLevelGrid;
  /** Build one tile placement, attaching layer-specific request metadata. */
  protected abstract makeTile(
    ctx      : TileLevelContext,
    gridIdx  : number,
    voxelPos : number[],
    level    : number,
    region   : { start: number[]; size: number[] },
  ): TilePlacement;
  /** Map a planned tile position to a source fetch position. */
  protected abstract fetchPosition(ctx: TileLevelContext, voxelPos: number[]): number[];
  /** Push the plan's viewport + grid metadata into the layer's params. */
  protected abstract syncGridParams(plan: TilePlan<TilePlacement>): void;

  // === Shared tile lifecycle ===

  /** Public accessor for current pyramid level */
  override getCurrentLevel(): number {
    return this.currentLevel;
  }

  override setSelection(key: string, value: number): void {
    if (this.selection[key] !== value) {
      this.selection[key] = value;
      this.dataVersion++;
    }
  }

  protected override applyOptions(desc: LayerConfig): void {
    super.applyOptions(desc);
    this.region = readRegion(desc.options?.region);
    this.finestLevel = optBoolean(desc.options?.finestLevel) ?? false;
  }

  protected getNormalizedRegion(): { min: Vec3; max: Vec3 } | undefined {
    return this.region;
  }

  /** Update the data source (e.g., when channel changes) */
  override setSource(source: Data): void {
    if (!sourceChanged(source, this.source)) return;
    this.source = source;
    this.dataVersion++;
    this.resolveSourceDescriptor();
  }

  // === Declarative source descriptors (Data.source) ===

  /**
   * The config source overlaid with descriptor-resolved runtime artifacts.
   * Explicit `pyramid`/`fetch` in the config always win over resolved ones.
   */
  protected get effectiveSource(): Data | undefined {
    const source   = this.source;
    const resolved = this.resolvedSource;
    if (!source || !resolved) return source;
    return {
      ...source,
      pyramid : source.pyramid ?? resolved.pyramid,
      fetch   : source.fetch   ?? resolved.fetch,
    };
  }

  /** Runtime artifacts produced by the last successful descriptor resolution. */
  getResolvedSource(): ResolvedSource | undefined {
    return this.resolvedSource;
  }

  /**
   * Ready unless a declarative source descriptor still needs resolution.
   * Sources with an explicit `pyramid`/`fetch` (and sources without a
   * descriptor) are always ready, matching the pre-descriptor behavior.
   */
  override get isReady(): boolean {
    const source = this.source;
    if (!source?.source || source.pyramid || source.fetch) return true;
    return this.resolvedSource !== undefined;
  }

  /**
   * Kick off asynchronous resolution of `source.source` (if any) through
   * `sourceRegistry`. Explicit `pyramid`/`fetch` take precedence — the
   * descriptor is ignored while either is present.
   *
   * Failure semantics: the error is logged via `console.error` with the
   * descriptor and the layer stays not-ready; the Galavi instance and other
   * layers are unaffected.
   */
  private resolveSourceDescriptor(): void {
    this.sourceEpoch++;
    this.resolvedSource = undefined;

    const source = this.source;
    const desc   = source?.source;
    if (!desc || source?.pyramid || source?.fetch) return;

    const epoch = this.sourceEpoch;
    let pending: Promise<ResolvedSource>;
    try {
      pending = sourceRegistry.create(desc.type, desc);
    } catch (err) {
      // Unknown source type — `create` throws synchronously.
      this.logSourceError(err, desc);
      return;
    }

    pending.then((resolved) => {
      if (epoch !== this.sourceEpoch) return; // superseded by a newer source
      this.resolvedSource = resolved;
      if (resolved.selection) {
        for (const [key, value] of Object.entries(resolved.selection)) {
          if (this.selection[key] === undefined) this.selection[key] = value;
        }
      }
      this.onSourceResolved(resolved);
      this.dataVersion++;
      // A renderer built before resolution has no tile residency; bump the
      // geometry version so the view rebuilds it against the resolved pyramid.
      this.geometryVersion++;
      this.requestRender();
    }).catch((err) => {
      if (epoch !== this.sourceEpoch) return;
      this.logSourceError(err, desc);
    });
  }

  private logSourceError(err: unknown, desc: SourceDescriptor): void {
    console.error(
      `[${this.tileLabel}] Failed to resolve source for layer "${this.id}" — layer stays not-ready:`,
      err,
      desc,
    );
  }

  /**
   * Hook invoked after a source descriptor resolves. Subclasses may re-derive
   * pyramid-dependent state here (e.g. SliceLayer's plane sizes).
   */
  protected onSourceResolved(_resolved: ResolvedSource): void {}

  /** Tile residency descriptor — view-side LayerRenderer allocates the pool. */
  override getTileSpec(): TileSpec | null {
    const pyramid = this.effectiveSource?.pyramid;
    if (!pyramid?.levels.length) return null;
    return {
      slotSize      : this.slotSize(pyramid),
      initialLevel  : pyramid.levels.length - 1,
      format        : "r16float",
      bytesPerTexel : 2,
      label         : `${this.tileLabel}[${this.id}]`,
      maxPoolSize   : this.maxPoolSize,
    };
  }

  /**
   * Plan the storage chunks intersecting this frame's visible bounds. The
   * renderer may force the coarsest level for the initial frame; subsequent
   * calls select automatically from physical scale and canvas size.
   */
  override planTiles(viewport: TileViewport): TileFramePlan | null {
    const source  = this.effectiveSource;
    const pyramid = source?.pyramid;
    if (!source || !pyramid?.levels.length) return null;

    const bounds = this.cropBounds(viewport.bounds);
    const level = viewport.forcedLevel ?? (this.finestLevel
      ? 0
      : pickPyramidLevel(pyramid, {
          worldUnitsPerPixel : viewport.selectionUnitsPerPixel ?? viewport.worldUnitsPerPixel,
          axes               : this.levelAxes,
          currentLevel       : viewport.currentLevel,
          bounds,
          tileBudget         : viewport.tileBudget,
        }));
    this.currentLevel = level;

    const ctx  : TileLevelContext = { pyramid, level, levelInfo: pyramid.levels[level] };
    const grid = this.levelGrid(ctx);
    const plan = planTiles({
      bounds,
      chunkSize : grid.chunkSize,
      resSize   : grid.resSize,
      gridDim   : grid.gridDim,
      level,
      makeTile  : (gridIdx, voxelPos, lvl, region) =>
        this.makeTile(ctx, gridIdx, voxelPos, lvl, region),
    });

    this.syncGridParams(plan);

    const selection = this.selection;
    return {
      plan,
      loader: {
        fetch: (req, signal) => buildTileFetcher(source, selection)({
          level    : req.level,
          position : this.fetchPosition(ctx, req.voxelPos),
          signal,
        }),
      },
    };
  }

  private cropBounds(bounds: TileViewport["bounds"]): TileViewport["bounds"] {
    const region = this.region;
    if (!region) return bounds;

    const min = this.levelAxes.map((axis, index) => (
      Math.max(bounds.min[index] ?? 0, region.min[axis])
    ));
    const max = this.levelAxes.map((axis, index) => (
      Math.max(min[index], Math.min(bounds.max[index] ?? 1, region.max[axis]))
    ));
    return { min, max };
  }
}

function readRegion(value: unknown): { min: Vec3; max: Vec3 } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { min?: unknown; max?: unknown };
  if (
    !Array.isArray(candidate.min) || candidate.min.length !== 3 ||
    !Array.isArray(candidate.max) || candidate.max.length !== 3 ||
    !candidate.min.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ||
    !candidate.max.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) return undefined;

  const min = candidate.min.map((entry) => Math.max(0, Math.min(1, entry))) as Vec3;
  const max = candidate.max.map((entry, axis) => (
    Math.max(min[axis], Math.min(1, entry))
  )) as Vec3;
  return { min, max };
}
