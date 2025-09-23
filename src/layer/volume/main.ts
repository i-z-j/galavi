/**
 * VolumeLayer - 3D volume rendering
 * 
 * Renders volumetric data with cube geometry and 3D texture sampling.
 * Supports tile-based loading for large datasets.
 *
 * Strategy (mirrors 2D SliceLayer):
 * - Always use 3x3x3 = 27 tiles to cover viewport cube [0,1]³
 * - Higher resolution = smaller portion of volume visible
 * - Tiles map to viewport grid cells, not world positions
 * - Ray marching scoped to [0,1]³ viewport cube
 */

import type {
  Data,
  LayerConfig,
  Vec3,
} from "../../types";
import {
  UNIT_CUBE,
  buildTileFetcher,
  getPyramidLevelScale,
  planTiles,
  resolvePyramidLevel,
  sourceChanged,
  type TileFramePlan,
  type TileSpec,
} from "../../utils";
import {
  BaseLayer,
  transformAABB,
  type Geometry,
  type LayerParams,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// === Volume Parameters ===

// Must match shader step multiplier (see volume/shader.wgsl)
// Step size is in viewport space (0..1)
const VOLUME_STEP_SIZE = 0.008;

export interface VolumeConfig {
  /** Data source descriptor */
  source?        : Data;
  /** Volume size [x, y, z] in voxels at full resolution */
  dataSize?      : Vec3;
  /** Per-level voxel scaling relative to level 0, indexed by level. */
  levelScales?   : Vec3[];
  /**
   * Physical scale at level 0 (physical units per voxel, e.g. μm/voxel).
    * Used by scalebar and other overlays for physical-unit display.
   */
  scale?         : number;
  /** Pyramid level range [min, max] */
  levelRange?    : [number, number];
  /** Contrast range [min, max] */
  contrastRange? : [number, number];
  /** Tile size in voxels [x, y, z] (default: 64³) */
  tileSize?      : Vec3;
  /** Maximum pool size (default: Infinity) */
  maxPoolSize?   : number;
  /** Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into urlTemplate or passed to source.fetch. */
  selection?     : Record<string, number>;
}

export interface VolumeTileUpdateOptions {
  resolutionMode?  : 'auto' | 'manual';
  resolutionLevel? : number;
}

export class VolumeLayerParams implements LayerParams {
  private contrast       : [number, number] = [0, 1];
  private opacity                           = 1;
  private viewportOrigin : Vec3 = [0, 0, 0];
  private viewportSize   : Vec3 = [1, 1, 1];
  private cameraPosition : Vec3 = [0, 0, 0];

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

  // Layout: contrast(2), step(1), opacity(1), viewport_origin(3), _pad,
  // viewport_size(3), _pad, viewport_inv_size(3), _pad,
  // ray_origin_view(3), _pad = 20 floats
  private readonly _buffer = new Float32Array(20);
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
    return b;
  }
}

// === Volume Data ===

interface VolumeTile {
  gridIdx   : number;
  voxelPos  : number[];
  id        : string;
  level     : number;
}

export class VolumeLayer extends BaseLayer {
  static readonly layerType = "volume";
  static fromConfig(id: string, desc: LayerConfig): VolumeLayer {
    const opts = desc.options ?? {};
    return new VolumeLayer(id, {
      source        : desc.data,
      dataSize      : (opts.dataSize as Vec3) ?? undefined,
      levelScales   : (opts.levelScales as Vec3[]) ?? undefined,
      levelRange    : (opts.levelRange as [number, number]) ?? undefined,
      contrastRange : (opts.contrastRange as [number, number]) ?? undefined,
      scale         : opts.scale as number | undefined,
      selection     : opts.selection as Record<string, number> | undefined,
      tileSize      : (opts.tileSize as Vec3) ?? undefined,
      maxPoolSize   : opts.maxPoolSize as number | undefined,
    });
  }

  protected override shaderCode = shaderCode;
  private params : VolumeLayerParams;

  private source?               : Data;
  readonly dataSize             : Vec3;
  override readonly levelRange  : [number, number];
  readonly levelScales?         : Vec3[];
  readonly tileSize             : Vec3;
  private maxPoolSize?          : number;
  private selection             : Record<string, number>;

  // Tile tracking
  private currentLevel : number;
  /** Public accessor for current pyramid level */
  override getCurrentLevel(): number {
    return this.currentLevel;
  }

  // Viewport transform (volume coords where viewport [0,1]³ maps to)
  private viewportOrigin : Vec3 = [0, 0, 0];
  private viewportSize   : Vec3 = [1, 1, 1];

  constructor(id?: string, config?: VolumeConfig) {
    super(id);
    this.params = new VolumeLayerParams(config);
    this.source = config?.source;
    this.dataSize = config?.dataSize ?? [1, 1, 1];
    this.levelRange = config?.levelRange ?? [0, 6];
    this.levelScales = config?.levelScales;
    this.tileSize = config?.tileSize ?? [64, 64, 64];
    this.maxPoolSize = config?.maxPoolSize;
    this.selection = config?.selection ? { ...config.selection } : {};
    // G4: initialize to a valid pyramid level so any pre-update sentinel reads
    // never inject -1 / NaN into URL templates.
    this.currentLevel = this.levelRange[0];
  }

  private getLevelScale(level: number): Vec3 {
    return getPyramidLevelScale(level, this.levelScales);
  }

  /** Tile residency descriptor — view-side LayerRenderer allocates the pool. */
  override getTileSpec(): TileSpec | null {
    if (!this.source) return null;
    return {
      tileSize      : this.tileSize,
      gridCells     : 27,
      format        : "r16float",
      bytesPerTexel : 2,
      label         : `VolumeLayer[${this.id}]`,
      maxPoolSize   : this.maxPoolSize,
    };
  }

  /**
   * Plan this frame's 3×3×3 tile grid. Pure-ish: updates `currentLevel` and the
   * viewport that the layer params reference, but does not touch the GPU.
   *
   * Strategy:
   * - effectiveScale determines resolution level
   * - 3x3x3 tiles always cover viewport [0,1]³
   * - Target determines which portion of volume is visible
   * - Viewport is offset/scaled so target stays at center
   */
  override planTiles(
    target          : Vec3,
    effectiveScale  : number,
    options         : VolumeTileUpdateOptions = {},
  ): TileFramePlan<VolumeTile> | null {
    if (!this.source) return null;

    // effectiveScale > 1 = zoomed in = finer level (lower level number)
    // When per-level scales are provided, select the coarsest level whose
    // sampling density still satisfies the requested scale.
    const level = resolvePyramidLevel(effectiveScale, this.levelRange, {
      resolutionMode  : options.resolutionMode,
      resolutionLevel : options.resolutionLevel,
      levelScales     : this.levelScales,
      fallbackLevel   : this.currentLevel,
    });
    this.currentLevel = level;

    // Volume size at this level (in voxels)
    const resScale = this.getLevelScale(level);
    const resSize: Vec3 = [
      this.dataSize[0] / resScale[0],
      this.dataSize[1] / resScale[1],
      this.dataSize[2] / resScale[2],
    ];

    const plan = planTiles<VolumeTile>({
      target,
      tileSize : this.tileSize,
      resSize,
      gridDim  : 3,
      level,
      makeTile : (gridIdx, voxelPos, lvl) => ({
        gridIdx,
        voxelPos,
        level : lvl,
        id    : `${lvl}:${voxelPos.join(",")}`,
      }),
    });

    this.viewportOrigin = plan.viewportOrigin as Vec3;
    this.viewportSize   = plan.viewportSize as Vec3;
    this.params.setViewport(this.viewportOrigin, this.viewportSize);

    const source    = this.source;
    const selection = this.selection;
    return {
      plan,
      loader: {
        fetch: (req) => buildTileFetcher(source, selection)({
          level    : req.level,
          position : req.voxelPos,
        }),
        region: (req) => {
          const gx = req.gridIdx % 3;
          const gy = Math.floor(req.gridIdx / 3) % 3;
          const gz = Math.floor(req.gridIdx / 9);
          return {
            start: [gx / 3, gy / 3, gz / 3],
            scale: [3.0, 3.0, 3.0],
          };
        },
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
