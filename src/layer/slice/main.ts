/**
 * SliceLayer - 2D slice rendering
 * 
 * Renders 2D slices (XY, YZ, XZ projections) from volumetric data.
 * Uses square geometry with 2D texture sampling.
 * Supports tile-based loading for large datasets.
 */

import type {
  Data,
  LayerConfig,
  PhysicalSpace,
  Vec3,
} from "../../types";
import {
  buildTileFetcher,
  planTiles,
  resolveAxes,
  resolvePyramidLevel,
  sourceChanged,
  type AxisMap,
  type TileFramePlan,
  type TileSpec,
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
   * Full volume dimensions [x, y, z] in voxels at full resolution.
   * Used to auto-compute in-plane size, slice count, and default sliceIndex.
   */
  dataSize?      : Vec3;
  /**
   * MIP thickness (voxels per slice along the slice axis).
   * Scalar — each slice entry is for one plane, so one value suffices.
   * Default: 1 (no MIP compression).
   */
  mipThickness?  : number;
  /**
   * Physical scale at level 0 (physical units per voxel, e.g. μm/voxel).
    * Used by scalebar and other overlays for physical-unit display.
   */
  scale?         : number;
  /** Pyramid level range [min, max] for tile loading */
  levelRange?    : [number, number];
  /** Contrast range [min, max] */
  contrastRange? : [number, number];
  /** Tile size in pixels [u, v] (default: 512²). Stored as [w, h, 1] for unified 3D pool. */
  tileSize?      : [number, number];
  /** Current slice index along the through-plane axis */
  sliceIndex?    : number;
  /** Maximum pool size (default: Infinity) */
  maxPoolSize?   : number;
  /** Non-spatial dimension selection, e.g. { c: 0, t: 5 }. Substituted into urlTemplate or passed to source.fetch. */
  selection?     : Record<string, number>;
}

export class SliceLayerParams implements LayerParams {
  private contrast       : [number, number] = [0, 1];
  private opacity                           = 1;
  private viewportOrigin : [number, number] = [0, 0];
  private viewportSize   : [number, number] = [1, 1];

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

  // Layout: contrast(2f), opacity(1f), _pad(1f), viewport_origin(2f), viewport_size(2f) = 8 floats
  private readonly _buffer = new Float32Array(8);
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
    return b;
  }
}

// === Slice Layer ===

export interface SliceTileUpdateOptions {
  resolutionMode?  : 'auto' | 'manual';
  resolutionLevel? : number;
}

interface SliceTile {
  gridIdx   : number;
  voxelPos  : number[];
  id        : string;
  level     : number;
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
        dataSize      : (opts.dataSize as Vec3) ?? undefined,
        mipThickness  : opts.mipThickness as number | undefined,
        scale         : opts.scale as number | undefined,
        selection     : opts.selection as Record<string, number> | undefined,
        levelRange    : (opts.levelRange as [number, number]) ?? undefined,
        contrastRange : (opts.contrastRange as [number, number]) ?? undefined,
        tileSize      : (opts.tileSize as [number, number]) ?? undefined,
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
  override readonly levelRange : [number, number];
  private tileSize     : Vec3;
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
    this.levelRange   = cfg.levelRange ?? [0, 6];
    const ts          = cfg.tileSize ?? [512, 512];
    this.tileSize     = [ts[0], ts[1], 1]; // Unified 3D tile: depth=1 for 2D slices
    this.maxPoolSize  = cfg.maxPoolSize;

    // Store dataSize and auto-compute in-plane size + slice count
    this.dataSize = cfg.dataSize ?? [1, 1, 1];
    const [u, v, s] = this.axisMap;
    this.size = [
      this.dataSize[u],
      this.dataSize[v],
      Math.ceil(this.dataSize[s] / this.mipThickness),
    ];
    this.sliceCount = this.size[2];

    // Default sliceIndex to center of through-plane axis
    this.sliceIndex = cfg.sliceIndex ?? Math.floor(this.sliceCount / 2);

    // G4: initialize to a valid pyramid level so any pre-update sentinel reads
    // never inject -1 / NaN into URL templates.
    this.currentLevel = this.levelRange[0];
  }

  /** Tile residency descriptor — view-side LayerRenderer allocates the pool. */
  override getTileSpec(): TileSpec | null {
    if (!this.source) return null;
    return {
      tileSize      : this.tileSize,
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
    this.setTransform({ scale: [physical.spatial.size[uAxis], physical.spatial.size[vAxis], 1] });
  }

  /** Plan this frame's 3×3 in-plane tile grid. Pure-ish: no GPU touched. */
  override planTiles(
    target          : [number, number],
    effectiveScale  : number,
    options         : SliceTileUpdateOptions = {},
  ): TileFramePlan<SliceTile> | null {
    if (!this.source) return null;

    // Compute pyramid level from effective scale (or use manual override)
    const level = resolvePyramidLevel(effectiveScale, this.levelRange, {
      resolutionMode  : options.resolutionMode,
      resolutionLevel : options.resolutionLevel,
      fallbackLevel   : this.currentLevel,
    });
    this.currentLevel = level;

    const resScale = 2 ** level;
    const resSize  = [
      this.size[0] / resScale,
      this.size[1] / resScale,
    ];

    const sliceIdx = this.sliceIndex;
    const plan = planTiles<SliceTile>({
      target,
      tileSize : [this.tileSize[0], this.tileSize[1]],
      resSize,
      gridDim  : 2,
      level,
      // Slice planner uses bucket=0 origin (filter handles out-of-bounds tiles).
      minBucket: 0,
      makeTile : (gridIdx, voxelPos, lvl) => ({
        gridIdx,
        voxelPos,
        level : lvl,
        id    : `${lvl}:${sliceIdx},${voxelPos.join(",")}`,
      }),
    });

    this.viewportOrigin = plan.viewportOrigin as [number, number];
    this.viewportSize   = plan.viewportSize as [number, number];
    this.params.setViewport(this.viewportOrigin, this.viewportSize);

    const source    = this.source;
    const selection = this.selection;
    return {
      plan,
      loader: {
        fetch: (req) => buildTileFetcher(source, selection)({
          level    : req.level,
          position : this.getFetchPosition(req.voxelPos, sliceIdx),
        }),
        // Slice shader computes grid-cell UV on the fly; identity region suffices.
        region: () => ({ start: [0, 0, 0], scale: [1, 1, 1] }),
      },
      inBounds: (tile) => (
        tile.voxelPos[0] >= 0 &&
        tile.voxelPos[1] >= 0 &&
        tile.voxelPos[0] < resSize[0] &&
        tile.voxelPos[1] < resSize[1]
      ),
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
