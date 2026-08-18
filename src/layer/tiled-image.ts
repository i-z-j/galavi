/**
 * TiledImageLayer — shared base for pyramid-backed tiled image layers
 * (VolumeLayer: 3D chunks, SliceLayer: 2D planes).
 *
 * Owns everything the two layers do identically: source/selection state and
 * versioning, the tile-residency spec, and the per-frame plan flow (level
 * pick → chunk enumeration → params sync → loader). The genuine dimensional
 * differences stay in the concrete layer as small hooks: level-selection
 * axes, slot-size computation, level-grid projection, tile metadata,
 * fetch-position mapping, and viewport/grid params arity.
 *
 * Sources are explicit `Data` configs (`pyramid`/`fetch`/`url`…); dataset
 * kinds produce them — there is no per-layer source resolution.
 */

import type {
  Data,
  ImagePyramid,
  ImagePyramidLevel,
  LayerConfig,
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
import { BaseLayer, type LayerLoadStatus } from "./base";

/** Options shared by every tiled image layer. */
export interface TiledImageOptions {
  /** Data source descriptor */
  source?      : Data;
  /** Optional tile-atlas slot cap. Explicit low-level override: when set, it
   * wins and the volume layer's automatic preview-budget policy (DX-M4) is
   * disabled. When unset, volume layers bound pathological z-chunk=1 pyramids
   * automatically; other layers derive the cap from a 128 MiB budget. */
  maxPoolSize? : number;
  /**
   * Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into
   * urlTemplate or passed to source.fetch.
   *
   * This is the ONLY path for non-spatial dimensions: top-level keys such as
   * `c` / `t` / `z` directly on this options bag are never read — unknown
   * option keys are ignored per the config-boundary policy (with a
   * development-mode console warning naming the stray keys).
   */
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

// === Dev-time unknown-option-key diagnostics (DX-Q1) ===

/**
 * Option keys recognized by every tiled image layer: the TiledImageOptions
 * bag plus the base-dispatched `timepoint` (BaseLayer.applyOptions) and
 * `contrastRange` (BaseLayer.applyRenderConfig). Subclasses with additional
 * option keys extend the list via {@link TiledImageLayer.knownOptionKeys}.
 * Not part of the public API.
 */
export const TILED_IMAGE_OPTION_KEYS: readonly string[] = [
  "source",
  "maxPoolSize",
  "selection",
  "region",
  "finestLevel",
  "timepoint",
  "contrastRange",
];

/**
 * DEVELOPMENT-only diagnostic: unknown option keys are silently ignored by
 * the config-boundary policy, which hid real defects (a top-level `c` never
 * reaches the channel axis — every channel rendered channel 0). Warn, never
 * throw; the keys stay ignored.
 *
 * Gating: callers wrap the call in `import.meta.env?.DEV !== false`. Vite's
 * production build statically replaces `import.meta.env.DEV` (including the
 * optional-chained form) with `false`, so rollup tree-shakes the guarded
 * branch — and this then-unreferenced helper — out of dist. Everywhere else
 * (vitest, plain node, unbundled ESM) `import.meta.env` is undefined or
 * DEV=true, so the warning stays on unless a bundler proves production.
 */
function warnUnknownOptionKeys(
  label   : string,
  id      : string,
  options : Record<string, unknown> | undefined,
  known   : readonly string[],
): void {
  if (!options) return;
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  console.warn(
    `[${label}] Layer "${id}" received unknown option key(s): ` +
    `${unknown.map((key) => `"${key}"`).join(", ")} — ignored. ` +
    "Non-spatial dimension selections (c, t, z, …) belong in `options.selection`, " +
    "e.g. { selection: { c: 2 } }.",
  );
}

export abstract class TiledImageLayer extends BaseLayer {
  protected source?      : Data;
  protected maxPoolSize? : number;
  protected selection    : Record<string, number>;
  private region?        : { min: Vec3; max: Vec3 };
  private finestLevel    = false;

  private currentLevel : number;

  constructor(id?: string, config?: TiledImageOptions) {
    super(id);
    if (import.meta.env?.DEV !== false) {
      warnUnknownOptionKeys(
        this.tileLabel, this.id,
        config as Record<string, unknown> | undefined,
        this.knownOptionKeys,
      );
    }
    this.source       = config?.source;
    this.maxPoolSize  = config?.maxPoolSize;
    this.selection    = config?.selection ? { ...config.selection } : {};
    this.region       = readRegion(config?.region);
    this.finestLevel  = config?.finestLevel === true;
    this.currentLevel = Math.max(0, (this.source?.pyramid?.levels.length ?? 1) - 1);
  }

  // === Dimensional hooks (the real 2D/3D differences) ===

  /** Debug label prefix for the tile pool and diagnostics (e.g. "VolumeLayer"). */
  protected get tileLabel(): string { return "TiledImageLayer"; }
  /**
   * Option keys this layer recognizes, for the dev-only unknown-key warning.
   * Subclasses with extra option keys override and extend the base list.
   */
  protected get knownOptionKeys(): readonly string[] {
    return TILED_IMAGE_OPTION_KEYS;
  }
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
    if (import.meta.env?.DEV !== false) {
      warnUnknownOptionKeys(this.tileLabel, this.id, desc.options, this.knownOptionKeys);
    }
    super.applyOptions(desc);
    const region = readRegion(desc.options?.region);
    if (!sameRegion(this.region, region)) {
      this.region = region;
      // The volume preview policy keys off the region (VolumeLayer), and the
      // effective source is memoized per source — drop the memo so the policy
      // re-evaluates against the new region.
      this.effectiveSourceCache = undefined;
    }
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
  }

  // === Effective source ===

  /**
   * The explicit config source passed through
   * {@link applyEffectiveSourcePolicy}; the result is memoized per source so
   * per-frame readers do not re-derive it.
   */
  private effectiveSourceCache?: {
    source : Data | undefined;
    value  : Data | undefined;
  };

  protected get effectiveSource(): Data | undefined {
    const source = this.source;
    const cache = this.effectiveSourceCache;
    if (cache && cache.source === source) return cache.value;
    const value = this.applyEffectiveSourcePolicy(source);
    this.effectiveSourceCache = { source, value };
    return value;
  }

  /**
   * Policy hook over the effective source — subclasses may substitute a
   * bounded pyramid/fetch pair (e.g. VolumeLayer's automatic preview budgets
   * for pathological z-chunk=1 pyramids, DX-M4). Identity by default. Must be
   * pure: the result is cached per source.
   */
  protected applyEffectiveSourcePolicy(source: Data | undefined): Data | undefined {
    return source;
  }

  /**
   * Load state (DX-M2): `"idle"` when no source is set, `"ready"` otherwise.
   * Sources are explicit configs — a `Data` without `pyramid`/`fetch` no
   * longer triggers any async resolution. A failed tracked load (ARCH-1)
   * still reports `"error"` via the base record.
   */
  override get loadStatus(): LayerLoadStatus {
    if (this.loadError !== undefined) return "error";
    return this.source ? "ready" : "idle";
  }

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

function sameRegion(
  first?: { min: Vec3; max: Vec3 },
  second?: { min: Vec3; max: Vec3 },
): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return first.min.every((v, i) => v === second.min[i]) &&
    first.max.every((v, i) => v === second.max[i]);
}
