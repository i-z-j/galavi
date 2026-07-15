/**
 * VolumeLayer - 3D volume rendering
 * 
 * Renders volumetric data with cube geometry and 3D texture sampling.
 * Supports tile-based loading for large datasets.
 *
 * The view supplies camera-derived local bounds; the layer selects a physical
 * best-fit pyramid level and requests every intersecting storage chunk.
 */

import type {
  Data,
  ImagePyramid,
  LayerConfig,
  Vec3,
} from "../../types";
import {
  UNIT_CUBE,
  buildTileFetcher,
  pickPyramidLevel,
  planTiles,
  sourceChanged,
  type TileFramePlan,
  type TileSpec,
  type TileViewport,
} from "../../utils";
import {
  BaseLayer,
  transformAABB,
  type Geometry,
  type LayerParams,
} from "../base";
import { VOLUME_STEP_SIZE } from "../../defaults";
import shaderCode from "./shader.wgsl?raw";

// === Volume Parameters ===

export interface VolumeConfig {
  /** Data source descriptor */
  source?        : Data;
  /** Contrast range [min, max] */
  contrastRange? : [number, number];
  /** Optional tile-atlas slot cap (default: derived from a 128 MiB budget) */
  maxPoolSize?   : number;
  /** Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into urlTemplate or passed to source.fetch. */
  selection?     : Record<string, number>;
}

export class VolumeLayerParams implements LayerParams {
  private contrast       : [number, number] = [0, 1];
  private opacity                           = 1;
  private viewportOrigin : Vec3 = [0, 0, 0];
  private viewportSize   : Vec3 = [1, 1, 1];
  private cameraPosition : Vec3 = [0, 0, 0];
  private gridOrigin     : Vec3 = [0, 0, 0];
  private tileNormSize   : Vec3 = [1, 1, 1];
  private gridShape      : Vec3 = [1, 1, 1];

  constructor(config: VolumeConfig = {}) {
    if (config.contrastRange) this.contrast = config.contrastRange;
  }

  setContrast(min: number, max: number): void {
    this.contrast = [min, max];
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  setViewport(origin: Vec3, size: Vec3): void {
    this.viewportOrigin = origin;
    this.viewportSize = size;
  }

  setEye(pos: Vec3): void {
    this.cameraPosition = pos;
  }

  setTileGrid(origin: Vec3, tileSize: Vec3, shape: Vec3): void {
    this.gridOrigin = origin;
    this.tileNormSize = tileSize;
    this.gridShape = shape;
  }

  // Layout: contrast(2), step(1), opacity(1), viewport_origin(3), _pad,
  // viewport_size(3), _pad, viewport_inv_size(3), _pad,
  // ray_origin_view(3), _pad, grid_origin(3), _pad,
  // tile_norm_size(3), _pad, grid_shape(3), _pad = 32 floats
  private readonly _buffer = new Float32Array(32);
  toBuffer(): Float32Array {
    const range     = this.contrast[1] - this.contrast[0];
    const scale     = range > 0 ? 1.0 / range : 1.0;
    const offset    = -this.contrast[0] * scale;
    const invX      = this.viewportSize[0] > 0 ? 1.0 / this.viewportSize[0] : 0;
    const invY      = this.viewportSize[1] > 0 ? 1.0 / this.viewportSize[1] : 0;
    const invZ      = this.viewportSize[2] > 0 ? 1.0 / this.viewportSize[2] : 0;
    const stepSize  = VOLUME_STEP_SIZE;
    const b = this._buffer;
    b[0]  = scale;                                                       b[1]  = offset; b[2]  = stepSize; b[3]  = this.opacity;
    b[4]  = this.viewportOrigin[0]; b[5]  = this.viewportOrigin[1];      b[6]  = this.viewportOrigin[2]; b[7]  = 0;
    b[8]  = this.viewportSize[0];   b[9]  = this.viewportSize[1];        b[10] = this.viewportSize[2];   b[11] = 0;
    b[12] = invX;                   b[13] = invY;                        b[14] = invZ;                   b[15] = 0;
    b[16] = (this.cameraPosition[0] - this.viewportOrigin[0]) * invX;
    b[17] = (this.cameraPosition[1] - this.viewportOrigin[1]) * invY;
    b[18] = (this.cameraPosition[2] - this.viewportOrigin[2]) * invZ;
    b[19] = 0;
    b[20] = this.gridOrigin[0];   b[21] = this.gridOrigin[1];   b[22] = this.gridOrigin[2];   b[23] = 0;
    b[24] = this.tileNormSize[0]; b[25] = this.tileNormSize[1]; b[26] = this.tileNormSize[2]; b[27] = 0;
    b[28] = this.gridShape[0];    b[29] = this.gridShape[1];    b[30] = this.gridShape[2];    b[31] = 0;
    return b;
  }
}

// === Volume Data ===

interface VolumeTile {
  gridIdx   : number;
  voxelPos  : number[];
  id        : string;
  level     : number;
  chunkSize : Vec3;
  region    : { start: Vec3; size: Vec3 };
}

export class VolumeLayer extends BaseLayer {
  static readonly layerType = "volume";
  static fromConfig(id: string, desc: LayerConfig): VolumeLayer {
    const opts = desc.options ?? {};
    return new VolumeLayer(id, {
      source        : desc.data,
      contrastRange : (opts.contrastRange as [number, number]) ?? undefined,
      selection     : opts.selection as Record<string, number> | undefined,
      maxPoolSize   : opts.maxPoolSize as number | undefined,
    });
  }

  protected override shaderCode = shaderCode;
  private params : VolumeLayerParams;

  private source?               : Data;
  private maxPoolSize?          : number;
  private selection             : Record<string, number>;

  // Tile tracking
  private currentLevel : number;
  /** Public accessor for current pyramid level */
  override getCurrentLevel(): number {
    return this.currentLevel;
  }

  override getLevelResolution(level: number): number | undefined {
    const scale = this.source?.pyramid?.levels[level]?.scale;
    return scale ? Math.max(scale[0], scale[1], scale[2]) : undefined;
  }

  // Viewport transform (volume coords where viewport [0,1]³ maps to)
  private viewportOrigin : Vec3 = [0, 0, 0];
  private viewportSize   : Vec3 = [1, 1, 1];

  constructor(id?: string, config?: VolumeConfig) {
    super(id);
    this.params = new VolumeLayerParams(config);
    this.source = config?.source;
    this.maxPoolSize = config?.maxPoolSize;
    this.selection = config?.selection ? { ...config.selection } : {};
    this.currentLevel = Math.max(0, (this.source?.pyramid?.levels.length ?? 1) - 1);
  }

  /** Tile residency descriptor — view-side LayerRenderer allocates the pool. */
  override getTileSpec(): TileSpec | null {
    const pyramid = this.source?.pyramid;
    if (!pyramid?.levels.length) return null;
    return {
      slotSize      : maxChunkSize(pyramid),
      initialLevel  : pyramid.levels.length - 1,
      format        : "r16float",
      bytesPerTexel : 2,
      label         : `VolumeLayer[${this.id}]`,
      maxPoolSize   : this.maxPoolSize,
    };
  }

  /**
   * Plan the storage chunks intersecting this frame's camera-derived local
   * bounds. The renderer may force the coarsest level for the initial frame;
   * subsequent calls select automatically from physical scale and canvas size.
   */
  override planTiles(
    viewport: TileViewport,
  ): TileFramePlan<VolumeTile> | null {
    const source  = this.source;
    const pyramid = source?.pyramid;
    if (!source || !pyramid?.levels.length) return null;

    const level = viewport.forcedLevel ?? pickPyramidLevel(pyramid, {
      worldUnitsPerPixel: viewport.selectionUnitsPerPixel ?? viewport.worldUnitsPerPixel,
      axes              : [0, 1, 2],
      currentLevel      : viewport.currentLevel,
      bounds            : viewport.bounds,
      tileBudget        : viewport.tileBudget,
    });
    this.currentLevel = level;
    const levelInfo = pyramid.levels[level];

    const plan = planTiles<VolumeTile>({
      bounds    : viewport.bounds,
      chunkSize : levelInfo.chunkSize,
      resSize   : levelInfo.shape,
      gridDim  : 3,
      level,
      makeTile : (gridIdx, voxelPos, lvl, region) => ({
        gridIdx,
        voxelPos,
        level : lvl,
        id    : `${lvl}:${voxelPos.join(",")}`,
        chunkSize: [...levelInfo.chunkSize] as Vec3,
        region: {
          start: [...region.start] as Vec3,
          size : [...region.size] as Vec3,
        },
      }),
    });

    this.viewportOrigin = plan.viewportOrigin as Vec3;
    this.viewportSize   = plan.viewportSize as Vec3;
    this.params.setViewport(this.viewportOrigin, this.viewportSize);
    this.params.setTileGrid(
      plan.gridOrigin.map((value, axis) => value * plan.tileNormSize[axis]) as Vec3,
      plan.tileNormSize as Vec3,
      plan.gridShape as Vec3,
    );

    const selection = this.selection;
    return {
      plan,
      loader: {
        fetch: (req) => buildTileFetcher(source, selection)({
          level    : req.level,
          position : req.voxelPos,
        }),
      },
    };
  }

  override setSelection(key: string, value: number): void {
    if (this.selection[key] !== value) {
      this.selection[key] = value;
      this.dataVersion++;
    }
  }

  override setContrast(min: number, max: number): void {
    this.params.setContrast(min, max);
  }

  /** Update the data source (e.g., when channel changes) */
  override setSource(source: Data): void {
    if (!sourceChanged(source, this.source)) return;
    this.source = source;
    this.dataVersion++;
  }

  getGeometry(): Geometry {
    return {
      vertices      : UNIT_CUBE,
      vertexCount   : 36,
      vertexStride  : 12,
      vertexFormat  : "float32x3",
      topology      : "triangle-list",
      instanceCount : 1,
    };
  }

  getParams(): LayerParams {
    this.params.setOpacity(this.opacity);
    return this.params;
  }

  /** World-space bounds of the unit volume cube under the current model matrix. */
  override getWorldAABB(): { min: Vec3; max: Vec3 } {
    return transformAABB([0, 0, 0], [1, 1, 1], this.modelMatrix);
  }
}

function maxChunkSize(pyramid: ImagePyramid): Vec3 {
  return pyramid.levels.reduce<Vec3>((max, level) => [
    Math.max(max[0], level.chunkSize[0]),
    Math.max(max[1], level.chunkSize[1]),
    Math.max(max[2], level.chunkSize[2]),
  ], [1, 1, 1]);
}
