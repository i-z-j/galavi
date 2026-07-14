/**
 * SliceLayer - 2D slice rendering
 * 
 * Renders 2D slices (XY, YZ, XZ projections) from volumetric data.
 * Uses square geometry with 2D texture sampling.
 * Supports tile-based loading for large datasets.
 */

import type {
  Data,
  ImagePyramid,
  LayerConfig,
  PhysicalSpace,
  Vec3,
} from "../../types";
import {
  buildTileFetcher,
  pickPyramidLevel,
  planTiles,
  resolveAxes,
  sourceChanged,
  type AxisMap,
  type TileFramePlan,
  type TileSpec,
  type TileViewport,
} from "../../utils";
import {
  BaseLayer,
  type Geometry,
  type LayerParams,
} from "../base";
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

export interface SliceConfig {
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
  /** Data source descriptor */
  source?        : Data;
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
  /** Optional tile-atlas slot cap (default: derived from a 128 MiB budget) */
  maxPoolSize?   : number;
  /** Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into urlTemplate or passed to source.fetch. */
  selection?     : Record<string, number>;
}

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

interface SliceTile {
  gridIdx   : number;
  voxelPos  : number[];
  id        : string;
  level     : number;
  chunkSize : Vec3;
  region    : { start: Vec3; size: Vec3 };
}

export class SliceLayer extends BaseLayer {
  static readonly layerType = "slice";
  static fromConfig(id: string, desc: LayerConfig): SliceLayer {
    const opts = desc.options ?? {};
    return new SliceLayer(
      id,
      {
        source        : desc.data,
        axes          : (opts.axes as (string | number)[]) ?? undefined,
        mipThickness  : opts.mipThickness as number | undefined,
        selection     : opts.selection as Record<string, number> | undefined,
        contrastRange : (opts.contrastRange as [number, number]) ?? undefined,
        sliceIndex    : opts.sliceIndex as number | undefined,
        maxPoolSize   : opts.maxPoolSize as number | undefined,
      },
    );
  }

  protected override shaderCode = shaderCode;
  /** Axis permutation: [uAxis, vAxis, sliceAxis] */
  readonly axisMap      : AxisMap;
  /** Volume dimensions [x, y, z] in voxels at full resolution */
  readonly dataSize     : Vec3;
  /** In-plane size [u, v] + slice count along through-plane axis */
  readonly size         : Vec3;
  /** Number of slices along the through-plane axis */
  readonly sliceCount   : number;
  /** Index of the slice axis (0=x, 1=y, 2=z) */
  readonly sliceAxis    : number;
  /** MIP thickness along the slice axis */
  readonly mipThickness : number;

  private params : SliceLayerParams;

  protected override applyOptions(desc: LayerConfig): void {
    super.applyOptions(desc);
    if (desc.options?.sliceIndex !== undefined) {
      this.setSliceIndex(desc.options.sliceIndex as number);
    }
  }
  private currentLevel : number;
  override getCurrentLevel(): number {
    return this.currentLevel;
  }
  private source?      : Data;
  private maxPoolSize? : number;
  private sliceIndex   : number;
  private selection    : Record<string, number>;

  // Viewport transform (world coords where viewport [0,1]² maps to)
  private viewportOrigin : [number, number] = [0, 0];
  private viewportSize   : [number, number] = [1, 1];

  constructor(id?: string, config?: SliceConfig) {
    super(id);
    const cfg = config ?? {} as SliceConfig;
    // Resolve axes config to axisMap
    this.axisMap      = resolveAxes(cfg.axes ?? ["x", "y"]);
    this.sliceAxis    = this.axisMap[2];
    this.mipThickness = cfg.mipThickness ?? 1;
    this.selection    = cfg.selection ? { ...cfg.selection } : {};
    this.params       = new SliceLayerParams(cfg);
    this.source       = cfg.source;
    this.maxPoolSize  = cfg.maxPoolSize;

    // Store dataSize and auto-compute in-plane size + slice count
    this.dataSize = this.source?.pyramid?.levels[0]?.shape ?? [1, 1, 1];
    const [u, v, s] = this.axisMap;
    this.size = [
      this.dataSize[u],
      this.dataSize[v],
      Math.ceil(this.dataSize[s] / this.mipThickness),
    ];
    this.sliceCount = this.size[2];

    // Default sliceIndex to center of through-plane axis
    this.sliceIndex = cfg.sliceIndex ?? Math.floor(this.sliceCount / 2);

    this.currentLevel = Math.max(0, (this.source?.pyramid?.levels.length ?? 1) - 1);
  }

  /** Tile residency descriptor — view-side LayerRenderer allocates the pool. */
  override getTileSpec(): TileSpec | null {
    const pyramid = this.source?.pyramid;
    if (!pyramid?.levels.length) return null;
    return {
      slotSize      : maxPlaneChunkSize(pyramid, this.axisMap),
      initialLevel  : pyramid.levels.length - 1,
      format        : "r16float",
      bytesPerTexel : 2,
      label         : `SliceLayer[${this.id}]`,
      maxPoolSize   : this.maxPoolSize,
    };
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

  /** Plan every storage chunk intersecting this frame's visible slice bounds. */
  override planTiles(
    viewport: TileViewport,
  ): TileFramePlan<SliceTile> | null {
    const source  = this.source;
    const pyramid = source?.pyramid;
    if (!source || !pyramid?.levels.length) return null;

    const [uAxis, vAxis, sliceAxis] = this.axisMap;
    const level = viewport.level ?? pickPyramidLevel(pyramid, {
      worldUnitsPerPixel: viewport.worldUnitsPerPixel,
      axes              : [uAxis, vAxis],
      bounds            : viewport.bounds,
      tileBudget        : viewport.tileBudget,
    });
    this.currentLevel = level;
    const levelInfo = pyramid.levels[level];
    const resSize   = [levelInfo.shape[uAxis], levelInfo.shape[vAxis]];
    const chunkSize = [levelInfo.chunkSize[uAxis], levelInfo.chunkSize[vAxis]];
    const sliceIdx  = mapSliceIndex(
      this.sliceIndex,
      pyramid.levels[0].shape[sliceAxis],
      levelInfo.shape[sliceAxis],
    );
    const plan = planTiles<SliceTile>({
      bounds    : viewport.bounds,
      chunkSize,
      resSize,
      gridDim  : 2,
      level,
      makeTile : (gridIdx, voxelPos, lvl, region) => ({
        gridIdx,
        voxelPos,
        level : lvl,
        id    : `${lvl}:${sliceIdx},${voxelPos.join(",")}`,
        chunkSize: [chunkSize[0], chunkSize[1], 1],
        region: {
          start: [region.start[0], region.start[1], 0],
          size : [region.size[0], region.size[1], 1],
        },
      }),
    });

    this.viewportOrigin = plan.viewportOrigin as [number, number];
    this.viewportSize   = plan.viewportSize as [number, number];
    this.params.setViewport(this.viewportOrigin, this.viewportSize);
    this.params.setTileGrid(
      plan.gridOrigin.map((value, axis) => value * plan.tileNormSize[axis]) as [number, number],
      plan.tileNormSize as [number, number],
      plan.gridShape as [number, number],
    );

    const selection = this.selection;
    return {
      plan,
      loader: {
        fetch: (req) => buildTileFetcher(source, selection)({
          level    : req.level,
          position : this.getFetchPosition(req.voxelPos, sliceIdx),
        }),
      },
    };
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

  setSliceIndex(index: number): void {
    if (this.sliceIndex !== index) {
      this.sliceIndex = index;
      this.dataVersion++;
    }
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
      vertices      : SQUARE,
      vertexCount   : 6,
      vertexStride  : 8, // 2 floats * 4 bytes
      vertexFormat  : "float32x2",
      topology      : "triangle-list",
    };
  }

  getParams(): LayerParams {
    this.params.setOpacity(this.opacity);
    return this.params;
  }
}

function maxPlaneChunkSize(pyramid: ImagePyramid, axisMap: AxisMap): Vec3 {
  const [uAxis, vAxis] = axisMap;
  return pyramid.levels.reduce<Vec3>((max, level) => [
    Math.max(max[0], level.chunkSize[uAxis]),
    Math.max(max[1], level.chunkSize[vAxis]),
    1,
  ], [1, 1, 1]);
}

function mapSliceIndex(index: number, finestSize: number, levelSize: number): number {
  const normalized = (Math.max(0, index) + 0.5) / Math.max(1, finestSize);
  return Math.max(0, Math.min(levelSize - 1, Math.floor(normalized * levelSize)));
}
