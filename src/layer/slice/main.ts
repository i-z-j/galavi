/**
 * SliceLayer - 2D slice rendering
 * 
 * Renders 2D slices (XY, YZ, XZ projections) from volumetric data.
 * Uses square geometry with 2D texture sampling.
 * Supports tile-based loading for large datasets.
 *
 * Shared tile plumbing lives in TiledImageLayer; this class carries only the
 * 2D specifics (axis permutation, slice index, 2D plane grid, square geometry).
 */

import type {
  ImagePyramid,
  LayerConfig,
  PhysicalSpace,
  Vec3,
} from "../../types";
import {
  optArray,
  optAxis,
  optBoolean,
  optNumber,
  optNumberRecord,
  optVec2,
  resolveAxes,
  type AxisIndex,
  type AxisMap,
  type TilePlacement,
  type TilePlan,
} from "../../utils";
import {
  type Geometry,
  type LayerParams,
} from "../base";
import {
  TILED_IMAGE_OPTION_KEYS,
  TiledImageLayer,
  type TileLevelContext,
  type TileLevelGrid,
  type TiledImageOptions,
} from "../tiled-image";
import shaderCode from "./shader.wgsl?raw";

// === Square Geometry ===
// Unit square [0,1]² - 2 triangles, 6 vertices

const SQUARE = new Float32Array([
  0, 0,
  1, 0,
  1, 1,
  0, 0,
  1, 1,
  0, 1,
]);

// === Slice Parameters ===

export interface SliceConfig extends TiledImageOptions {
  /**
   * Axes defining the slice plane as [u, v].
   * Accepts strings ("x","y","z") or indices (0,1,2).
   * The remaining axis becomes the slice (through-plane) axis.
   *
   * @example ["x","y"] → XY plane (slice along Z)
   * @example ["y","z"] → YZ plane (slice along X)
   * @example [1, 0]    → flipped YX plane
   *
   * Default: ["x","y"] (XY plane)
   */
  axes?          : (string | number)[];
  /**
   * MIP thickness (voxels per slice along the slice axis).
   * Scalar — each slice entry is for one plane, so one value suffices.
   * Default: 1 (no MIP compression).
   */
  mipThickness?  : number;
  /** Contrast range [min, max] */
  contrastRange? : [number, number];
  /** Current slice index along the through-plane axis */
  sliceIndex?    : number;
}

/** Options accepted in `LayerConfig.options` for {@link SliceLayer}. */
export type SliceOptions = Omit<SliceConfig, "source">;

/** `LayerConfig` with the slice layer's typed options bag. */
export type SliceLayerConfig = LayerConfig<SliceOptions>;

export class SliceLayerParams implements LayerParams {
  private contrast       : [number, number] = [0, 1];
  private opacity                           = 1;
  private viewportOrigin : [number, number] = [0, 0];
  private viewportSize   : [number, number] = [1, 1];
  private gridOrigin     : [number, number] = [0, 0];
  private tileNormSize   : [number, number] = [1, 1];
  private gridShape      : [number, number] = [1, 1];

  constructor(config: SliceConfig) {
    if (config.contrastRange) this.contrast = config.contrastRange;
  }

  setContrast(min: number, max: number): void {
    this.contrast = [min, max];
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  setViewport(origin: [number, number], size: [number, number]): void {
    this.viewportOrigin = origin;
    this.viewportSize = size;
  }

  setTileGrid(
    origin   : [number, number],
    tileSize : [number, number],
    shape    : [number, number],
  ): void {
    this.gridOrigin = origin;
    this.tileNormSize = tileSize;
    this.gridShape = shape;
  }

  // Layout: contrast(2f), opacity, _pad, viewport_origin(2f), viewport_size(2f),
  // grid_origin(2f), tile_norm_size(2f), grid_shape(2f), _pad(2f) = 16 floats
  private readonly _buffer = new Float32Array(16);
  toBuffer(): Float32Array {
    const range  = this.contrast[1] - this.contrast[0];
    const scale  = range > 0 ? 1.0 / range : 1.0;
    const offset = -this.contrast[0] * scale;
    const b = this._buffer;
    b[0] = scale;
    b[1] = offset;
    b[2] = this.opacity;
    b[3] = 0;
    b[4] = this.viewportOrigin[0];
    b[5] = this.viewportOrigin[1];
    b[6] = this.viewportSize[0];
    b[7] = this.viewportSize[1];
    b[8] = this.gridOrigin[0];
    b[9] = this.gridOrigin[1];
    b[10] = this.tileNormSize[0];
    b[11] = this.tileNormSize[1];
    b[12] = this.gridShape[0];
    b[13] = this.gridShape[1];
    b[14] = 0;
    b[15] = 0;
    return b;
  }
}

// === Slice Layer ===

/** SliceLayer's recognized option keys: the tiled-image set plus slice specifics. */
const SLICE_OPTION_KEYS: readonly string[] = [
  ...TILED_IMAGE_OPTION_KEYS,
  "axes",
  "mipThickness",
  "sliceIndex",
];

export class SliceLayer extends TiledImageLayer {
  static readonly layerType = "slice";
  static fromConfig(id: string, desc: SliceLayerConfig): SliceLayer {
    const opts = desc.options ?? {};
    return new SliceLayer(
      id,
      {
        source        : desc.data,
        axes          : optArray(opts.axes, optAxis),
        mipThickness  : optNumber(opts.mipThickness),
        selection     : optNumberRecord(opts.selection),
        contrastRange : optVec2(opts.contrastRange),
        sliceIndex    : optNumber(opts.sliceIndex),
        maxPoolSize   : optNumber(opts.maxPoolSize),
        region        : opts.region,
        finestLevel   : optBoolean(opts.finestLevel),
      },
    );
  }

  protected override shaderCode = shaderCode;
  /** Axis permutation: [uAxis, vAxis, sliceAxis] */
  readonly axisMap      : AxisMap;
  /** Volume dimensions [x, y, z] in voxels at full resolution */
  dataSize!             : Vec3;
  /** In-plane size [u, v] + slice count along through-plane axis */
  size!                 : Vec3;
  /** Number of slices along the through-plane axis */
  sliceCount!           : number;
  /** Index of the slice axis (0=x, 1=y, 2=z) */
  readonly sliceAxis    : number;
  /** MIP thickness along the slice axis */
  readonly mipThickness : number;

  private params     : SliceLayerParams;
  private sliceIndex : number;

  protected override applyOptions(desc: LayerConfig): void {
    super.applyOptions(desc);
    const sliceIndex = optNumber(desc.options?.sliceIndex);
    if (sliceIndex !== undefined) {
      this.setSliceIndex(sliceIndex);
    }
  }

  constructor(id?: string, config?: SliceConfig) {
    super(id, config);
    const cfg = config ?? {} as SliceConfig;
    // Resolve axes config to axisMap
    this.axisMap      = resolveAxes(cfg.axes ?? ["x", "y"]);
    this.sliceAxis    = this.axisMap[2];
    this.mipThickness = cfg.mipThickness ?? 1;
    this.params       = new SliceLayerParams(cfg);

    // Store dataSize and auto-compute in-plane size + slice count
    this.derivePlaneSizes();

    // Default sliceIndex to center of through-plane axis
    this.sliceIndex = cfg.sliceIndex ?? Math.floor(this.sliceCount / 2);
  }

  /**
   * Derive dataSize / in-plane size / slice count from the effective pyramid.
   * Re-run when a declarative source descriptor resolves — until then the
   * pyramid is unknown and these hold the [1,1,1] placeholder.
   */
  private derivePlaneSizes(): void {
    this.dataSize = this.effectiveSource?.pyramid?.levels[0]?.shape ?? [1, 1, 1];
    const [u, v, s] = this.axisMap;
    this.size = [
      this.dataSize[u],
      this.dataSize[v],
      Math.ceil(this.dataSize[s] / this.mipThickness),
    ];
    this.sliceCount = this.size[2];
  }

  protected override onSourceResolved(): void {
    this.derivePlaneSizes();
    // Keep the current slice inside the newly resolved plane range.
    this.sliceIndex = Math.max(0, Math.min(this.sliceIndex, this.sliceCount - 1));
  }

  // === TiledImageLayer hooks (2D planes) ===

  protected override get tileLabel(): string { return "SliceLayer"; }
  protected override get knownOptionKeys(): readonly string[] {
    return SLICE_OPTION_KEYS;
  }
  protected get levelAxes(): readonly AxisIndex[] { return [this.axisMap[0], this.axisMap[1]]; }

  protected slotSize(pyramid: ImagePyramid): Vec3 {
    const [uAxis, vAxis] = this.axisMap;
    return pyramid.levels.reduce<Vec3>((max, level) => [
      Math.max(max[0], level.chunkSize[uAxis]),
      Math.max(max[1], level.chunkSize[vAxis]),
      1,
    ], [1, 1, 1]);
  }

  protected levelGrid(ctx: TileLevelContext): TileLevelGrid {
    const [uAxis, vAxis] = this.axisMap;
    return {
      gridDim   : 2,
      chunkSize : [ctx.levelInfo.chunkSize[uAxis], ctx.levelInfo.chunkSize[vAxis]],
      resSize   : [ctx.levelInfo.shape[uAxis], ctx.levelInfo.shape[vAxis]],
    };
  }

  protected makeTile(
    ctx      : TileLevelContext,
    gridIdx  : number,
    voxelPos : number[],
    level    : number,
    region   : { start: number[]; size: number[] },
  ): TilePlacement {
    const [uAxis, vAxis] = this.axisMap;
    const sliceIdx = this.levelSliceIndex(ctx);
    return {
      gridIdx,
      voxelPos,
      level,
      id        : `${level}:${sliceIdx},${voxelPos.join(",")}`,
      chunkSize : [ctx.levelInfo.chunkSize[uAxis], ctx.levelInfo.chunkSize[vAxis], 1],
      region    : {
        start : [region.start[0], region.start[1], 0],
        size  : [region.size[0], region.size[1], 1],
      },
    };
  }

  protected fetchPosition(ctx: TileLevelContext, voxelPos: number[]): number[] {
    return this.getFetchPosition(voxelPos, this.levelSliceIndex(ctx));
  }

  protected syncGridParams(plan: TilePlan<TilePlacement>): void {
    this.params.setViewport(
      plan.viewportOrigin as [number, number],
      plan.viewportSize as [number, number],
    );
    this.params.setTileGrid(
      plan.gridOrigin.map((value, axis) => value * plan.tileNormSize[axis]) as [number, number],
      plan.tileNormSize as [number, number],
      plan.gridShape as [number, number],
    );
  }

  /**
   * Remap 2D tile position + slice index to 3D fetch position
   * using the axis permutation. Plane-agnostic.
   */
  private getFetchPosition(pos: number[], sliceIndex: number): Vec3 {
    const result: Vec3 = [0, 0, 0];
    result[this.axisMap[0]] = pos[0];     // u → uAxis
    result[this.axisMap[1]] = pos[1];     // v → vAxis
    result[this.axisMap[2]] = sliceIndex; // slice → sliceAxis
    return result;
  }

  /** Slice index remapped onto a pyramid level's through-plane size. */
  private levelSliceIndex(ctx: TileLevelContext): number {
    return mapSliceIndex(
      this.sliceIndex,
      ctx.pyramid.levels[0].shape[this.sliceAxis],
      ctx.levelInfo.shape[this.sliceAxis],
    );
  }

  // === BaseLayer interface ===

  override getLevelResolution(level: number): number | undefined {
    const scale = this.effectiveSource?.pyramid?.levels[level]?.scale;
    if (!scale) return undefined;
    return Math.max(scale[this.axisMap[0]], scale[this.axisMap[1]]);
  }

  protected override applyTransformConfig(desc: LayerConfig, physical?: PhysicalSpace): void {
    super.applyTransformConfig(desc, physical);
    if (desc.data?.transform !== undefined || !physical?.spatial) return;

    const [uAxis, vAxis] = this.axisMap;
    // Slice layers render in plane-local 2D coordinates, so their X/Y scale must
    // follow the active slice axes rather than the global XYZ ordering.
    const origin = physical.spatial.origin ?? [0, 0, 0];
    this.setTransform({
      scale    : [physical.spatial.size[uAxis], physical.spatial.size[vAxis], 1],
      translate: [origin[uAxis], origin[vAxis], 0],
    });
  }

  setSliceIndex(index: number): void {
    if (this.sliceIndex !== index) {
      this.sliceIndex = index;
      this.dataVersion++;
    }
  }

  override setContrast(min: number, max: number): void {
    this.params.setContrast(min, max);
  }

  getGeometry(): Geometry {
    return {
      vertices      : SQUARE,
      vertexCount   : 6,
      vertexStride  : 8, // 2 floats * 4 bytes
      vertexFormat  : "float32x2",
      topology      : "triangle-list",
    };
  }

  protected getLayerParams(): LayerParams {
    return this.params;
  }
}

function mapSliceIndex(index: number, finestSize: number, levelSize: number): number {
  const normalized = (Math.max(0, index) + 0.5) / Math.max(1, finestSize);
  return Math.max(0, Math.min(levelSize - 1, Math.floor(normalized * levelSize)));
}
