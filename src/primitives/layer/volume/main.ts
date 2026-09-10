/**
 * VolumeLayer - 3D volume rendering
 * 
 * Renders volumetric data with cube geometry and 3D texture sampling.
 * Supports tile-based loading for large datasets.
 *
 * The view supplies camera-derived local bounds; the layer selects a physical
 * best-fit pyramid level and requests every intersecting storage chunk.
 * Shared tile plumbing lives in TiledImageLayer; this class carries only the
 * 3D specifics (cube geometry, raymarch params, 3D chunk grid).
 */

import type {
  Data,
  ImagePyramid,
  LayerConfig,
  Vec3,
  VolumeRenderMode,
} from "../../../state/schema";
import {
  UNIT_CUBE,
  optBoolean,
  optNumber,
  optNumberRecord,
  optString,
  optVec2,
  type AxisIndex,
} from "../../../utils";
import {
  planVolumePreview,
  tileId,
  VOLUME_PREVIEW_POOL_HEADROOM,
  type TilePlacement,
  type TilePlan,
  type TileSpec,
  type VolumePreviewPlan,
} from "../../../viewer/tile";
import {
  transformAABB,
  type Geometry,
  type LayerParams,
} from "../base";
import {
  TiledImageLayer,
  type TileLevelContext,
  type TileLevelGrid,
  type TiledImageOptions,
} from "../tiled-image/main";
import { VOLUME_STEP_SIZE } from "../../../defaults";
import shaderCode from "./shader.wgsl?raw";

// === Volume Parameters ===

/**
 * Volume layer config. The ray-march accumulation projection is a render
 * option, not an option-bag key: set it via `render.volumeProjection`
 * (`"mip" | "minip" | "mean"`, default `"mip"`).
 */
export interface VolumeConfig extends TiledImageOptions {
  /** Contrast range [min, max] */
  contrastRange? : [number, number];
}

/** Options accepted in `LayerConfig.options` for {@link VolumeLayer}. */
export type VolumeOptions = Omit<VolumeConfig, "source">;

/** `LayerConfig` with the volume layer's typed options bag. */
export type VolumeLayerConfig = LayerConfig<VolumeOptions>;

/** Numeric mode codes packed into the params uniform (must match shader.wgsl). */
const VOLUME_MODE_CODES: Record<VolumeRenderMode, number> = {
  mip   : 0,
  minip : 1,
  mean  : 2,
};

const VOLUME_MODES = Object.keys(VOLUME_MODE_CODES) as VolumeRenderMode[];

/**
 * Checked reader for `render.volumeProjection`, following the config-boundary
 * policy: a missing, wrong-typed, or unknown value reads as `undefined` so
 * the caller falls back to the default (`"mip"`).
 */
export function optVolumeMode(value: unknown): VolumeRenderMode | undefined {
  const str = optString(value);
  return VOLUME_MODES.includes(str as VolumeRenderMode)
    ? (str as VolumeRenderMode)
    : undefined;
}

export class VolumeLayerParams implements LayerParams {
  private contrast       : [number, number] = [0, 1];
  private opacity                           = 1;
  private mode           : VolumeRenderMode = "mip";
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

  setMode(mode: VolumeRenderMode): void {
    this.mode = mode;
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
  // tile_norm_size(3), _pad, grid_shape(3), mode(1) = 32 floats
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
    b[28] = this.gridShape[0];    b[29] = this.gridShape[1];    b[30] = this.gridShape[2];    b[31] = VOLUME_MODE_CODES[this.mode];
    return b;
  }
}

// === Volume Layer ===

export class VolumeLayer extends TiledImageLayer {
  static readonly layerType = "volume";
  static fromConfig(id: string, desc: VolumeLayerConfig): VolumeLayer {
    const opts = desc.options ?? {};
    return new VolumeLayer(id, {
      source        : desc.data,
      contrastRange : optVec2(opts.contrastRange),
      selection     : optNumberRecord(opts.selection),
      maxPoolSize   : optNumber(opts.maxPoolSize),
      region        : opts.region,
      finestLevel   : optBoolean(opts.finestLevel),
    });
  }

  protected override shaderCode = shaderCode;
  private params : VolumeLayerParams;

  constructor(id?: string, config?: VolumeConfig) {
    super(id, config);
    this.params = new VolumeLayerParams(config);
  }

  // === TiledImageLayer hooks (3D) ===

  protected override get tileLabel(): string { return "VolumeLayer"; }
  protected get levelAxes(): readonly AxisIndex[] { return [0, 1, 2]; }

  /**
   * Automatic volume tile-budget policy. Volume layers keep every z
   * slab of the chosen level resident, so z-chunk=1 pyramids with hundreds of
   * slabs per level are unrenderable as-is. When the app did NOT pass an
   * explicit `maxPoolSize` override, such pyramids are replaced here by a
   * bounded z-strided preview (see `planVolumePreview`), and `getTileSpec`
   * sizes the pool to hold the largest preview level. Well-behaved pyramids,
   * urlTemplate-only sources (no fetch to remap), explicit overrides, and
   * region-bounded layers pass through untouched: a `region` crop (e.g. the
   * 3D magnifier's level-0 voxel block) already bounds tile residency to the
   * ROI, and full resolution there is both affordable and the point of the
   * crop — a strided preview would visibly degrade it.
   */
  private previewPlan: VolumePreviewPlan | null = null;

  protected override applyEffectiveSourcePolicy(source: Data | undefined): Data | undefined {
    this.previewPlan = null;
    if (!source?.pyramid || !source.fetch || this.maxPoolSize !== undefined) {
      return source;
    }
    if (this.getNormalizedRegion()) return source;
    const plan = planVolumePreview(source.pyramid);
    if (!plan) return source;
    this.previewPlan = plan;
    return {
      ...source,
      pyramid : plan.pyramid,
      fetch   : plan.wrapFetch(source.fetch),
    };
  }

  override getTileSpec(): TileSpec | null {
    const spec = super.getTileSpec();
    if (spec && this.previewPlan && this.maxPoolSize === undefined) {
      spec.maxPoolSize = this.previewPlan.maxTiles + VOLUME_PREVIEW_POOL_HEADROOM;
    }
    return spec;
  }

  protected slotSize(pyramid: ImagePyramid): Vec3 {
    return pyramid.levels.reduce<Vec3>((max, level) => [
      Math.max(max[0], level.chunkSize[0]),
      Math.max(max[1], level.chunkSize[1]),
      Math.max(max[2], level.chunkSize[2]),
    ], [1, 1, 1]);
  }

  protected levelGrid(ctx: TileLevelContext): TileLevelGrid {
    return {
      gridDim   : 3,
      chunkSize : [...ctx.levelInfo.chunkSize],
      resSize   : [...ctx.levelInfo.shape],
    };
  }

  protected makeTile(
    ctx      : TileLevelContext,
    gridIdx  : number,
    voxelPos : number[],
    level    : number,
    region   : { start: number[]; size: number[] },
  ): TilePlacement {
    return {
      gridIdx,
      voxelPos,
      level,
      id        : tileId(level, voxelPos),
      chunkSize : [...ctx.levelInfo.chunkSize] as Vec3,
      region    : {
        start : [...region.start] as Vec3,
        size  : [...region.size] as Vec3,
      },
    };
  }

  protected fetchPosition(_ctx: TileLevelContext, voxelPos: number[]): number[] {
    return voxelPos;
  }

  protected syncGridParams(plan: TilePlan<TilePlacement>): void {
    this.params.setViewport(plan.viewportOrigin as Vec3, plan.viewportSize as Vec3);
    this.params.setTileGrid(
      plan.gridOrigin.map((value, axis) => value * plan.tileNormSize[axis]) as Vec3,
      plan.tileNormSize as Vec3,
      plan.gridShape as Vec3,
    );
  }

  // === BaseLayer interface ===

  override getLevelResolution(level: number): number | undefined {
    const scale = this.effectiveSource?.pyramid?.levels[level]?.scale;
    return scale ? Math.max(scale[0], scale[1], scale[2]) : undefined;
  }

  override setContrast(min: number, max: number): void {
    this.params.setContrast(min, max);
  }

  /** Set the ray-march accumulation mode (`"mip" | "minip" | "mean"`). */
  setMode(mode: VolumeRenderMode): void {
    this.params.setMode(mode);
  }

  protected override applyRenderConfig(desc: LayerConfig): void {
    super.applyRenderConfig(desc);
    this.setMode(optVolumeMode(desc.render?.volumeProjection) ?? "mip");
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

  protected getLayerParams(): LayerParams {
    return this.params;
  }

  /** World-space bounds of the unit volume cube under the current model matrix. */
  override getWorldAABB(): { min: Vec3; max: Vec3 } {
    const region = this.getNormalizedRegion();
    return transformAABB(
      region?.min ?? [0, 0, 0],
      region?.max ?? [1, 1, 1],
      this.modelMatrix,
    );
  }
}
