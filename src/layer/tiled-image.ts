/**
 * TiledImageLayer — shared base for pyramid-backed tiled image layers
 * (VolumeLayer: 3D chunks, SliceLayer: 2D planes).
 *
 * Owns everything the two layers do identically: source/selection state and
 * versioning, the tile-residency spec, and the per-frame plan flow
 * (level pick → chunk enumeration → params sync → loader). The genuine
 * dimensional differences stay in the concrete layer as small hooks:
 * level-selection axes, slot-size computation, level-grid projection,
 * tile metadata, fetch-position mapping, and viewport/grid params arity.
 */

import type {
  Data,
  ImagePyramid,
  ImagePyramidLevel,
  Vec3,
} from "../types";
import {
  buildTileFetcher,
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
import { BaseLayer } from "./base";

/** Options shared by every tiled image layer. */
export interface TiledImageOptions {
  /** Data source descriptor */
  source?      : Data;
  /** Optional tile-atlas slot cap (default: derived from a 128 MiB budget) */
  maxPoolSize? : number;
  /** Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into urlTemplate or passed to source.fetch. */
  selection?   : Record<string, number>;
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

  private currentLevel : number;

  constructor(id?: string, config?: TiledImageOptions) {
    super(id);
    this.source       = config?.source;
    this.maxPoolSize  = config?.maxPoolSize;
    this.selection    = config?.selection ? { ...config.selection } : {};
    this.currentLevel = Math.max(0, (this.source?.pyramid?.levels.length ?? 1) - 1);
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

  /** Update the data source (e.g., when channel changes) */
  override setSource(source: Data): void {
    if (!sourceChanged(source, this.source)) return;
    this.source = source;
    this.dataVersion++;
  }

  /** Tile residency descriptor — view-side LayerRenderer allocates the pool. */
  override getTileSpec(): TileSpec | null {
    const pyramid = this.source?.pyramid;
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
    const source  = this.source;
    const pyramid = source?.pyramid;
    if (!source || !pyramid?.levels.length) return null;

    const level = viewport.forcedLevel ?? pickPyramidLevel(pyramid, {
      worldUnitsPerPixel : viewport.selectionUnitsPerPixel ?? viewport.worldUnitsPerPixel,
      axes               : this.levelAxes,
      currentLevel       : viewport.currentLevel,
      bounds             : viewport.bounds,
      tileBudget         : viewport.tileBudget,
    });
    this.currentLevel = level;

    const ctx  : TileLevelContext = { pyramid, level, levelInfo: pyramid.levels[level] };
    const grid = this.levelGrid(ctx);
    const plan = planTiles({
      bounds    : viewport.bounds,
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
        fetch: (req) => buildTileFetcher(source, selection)({
          level    : req.level,
          position : this.fetchPosition(ctx, req.voxelPos),
        }),
      },
    };
  }
}
