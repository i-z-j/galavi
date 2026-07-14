/**
 * Tile — GPU texture cache for tiled data
 *
 * Manages a pre-allocated 3D texture where each "slot" holds one tile.
 * 2D tiles use depth=1 (same code path).
 */

import type { Data, ImagePyramid, ImagePyramidLevel, Vec3 } from "../types";

// ============================================================================
// TILE TYPES
// ============================================================================

export interface TileCoord {
  level     : number;
  position  : number[]; // [x, y] for 2D, [x, y, z] for 3D
}

/** Tile source — describes a tiled dataset for the tile pool / loader */
export interface TileSource {
  pyramid: ImagePyramid;
  fetchTile(coord: TileCoord): Promise<ArrayBuffer>;
}

export function buildTileFetcher(
  source    : Data,
  selection : Record<string, number> = {},
): (coord: TileCoord) => Promise<ArrayBuffer> {
  if (source.fetch) {
    return (coord) => {
      assertValidLevel(coord.level);
      return source.fetch!({
        level     : coord.level,
        position  : coord.position,
        selection,
      });
    };
  }

  return async (coord) => {
    assertValidLevel(coord.level);
    const url   = buildTileUrl(source, coord, selection);
    const resp  = await fetch(url);
    if (!resp.ok) throw new Error(`Tile fetch failed: ${resp.status}`);
    return resp.arrayBuffer();
  };
}

/**
 * Pyramid levels written into URL templates must be valid non-negative integers.
 */
function assertValidLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0) {
    throw new Error(`Invalid pyramid level: ${level}. Must be a non-negative integer.`);
  }
}

// ----------------------------------------------------------------------------
// Pyramid level resolution
// ----------------------------------------------------------------------------

export interface TileBounds {
  /** Inclusive lower bound in normalized data coordinates. */
  min: number[];
  /** Exclusive upper bound in normalized data coordinates. */
  max: number[];
}

export interface PyramidLevelSelection {
  /** Physical world units represented by one display pixel. */
  worldUnitsPerPixel: number;
  /** Spatial XYZ axes visible in this view, in view-coordinate order. */
  axes: readonly (0 | 1 | 2)[];
  /** Visible normalized data bounds, in the same order as `axes`. */
  bounds?: TileBounds;
  /** Maximum number of simultaneously visible storage chunks. */
  tileBudget?: number;
}

/** Count storage chunks intersecting normalized bounds at one pyramid level. */
export function countPyramidLevelTiles(
  level  : ImagePyramidLevel,
  axes   : readonly (0 | 1 | 2)[],
  bounds : TileBounds,
): number {
  let count = 1;
  for (let index = 0; index < axes.length; index++) {
    const axis       = axes[index];
    const shape      = Math.max(1, level.shape[axis]);
    const chunkSize  = Math.max(1, level.chunkSize[axis]);
    const lower      = Math.max(0, Math.min(1, bounds.min[index] ?? 0));
    const upper      = Math.max(lower, Math.min(1, bounds.max[index] ?? 1));
    if (upper <= lower) return 0;
    const firstChunk = Math.floor((lower * shape) / chunkSize);
    const lastChunk  = Math.max(firstChunk, Math.ceil((upper * shape) / chunkSize) - 1);
    count *= lastChunk - firstChunk + 1;
  }
  return count;
}

/**
 * Select the coarsest useful pyramid level for the current display.
 *
 * A level is useful while each visible-axis voxel projects to at most one
 * display pixel. This avoids loading resolution the canvas cannot show. If
 * that level's visible chunks exceed the cache budget, progressively coarser
 * levels are considered until the complete visible set fits.
 */
export function pickPyramidLevel(
  pyramid   : ImagePyramid,
  selection : PyramidLevelSelection,
): number {
  if (pyramid.levels.length === 0) {
    throw new Error("Image pyramid must contain at least one level");
  }

  const worldUnitsPerPixel = Math.max(selection.worldUnitsPerPixel, Number.EPSILON);
  let bestLevel = 0;
  for (let index = 0; index < pyramid.levels.length; index++) {
    const level = pyramid.levels[index];
    const projectedVoxelPixels = Math.max(
      ...selection.axes.map((axis) => level.scale[axis] / worldUnitsPerPixel),
    );
    if (projectedVoxelPixels <= 1 + 1e-6) bestLevel = index;
  }

  const budget = selection.tileBudget;
  const bounds = selection.bounds;
  if (budget === undefined || !bounds) return bestLevel;

  for (let index = bestLevel; index < pyramid.levels.length; index++) {
    if (countPyramidLevelTiles(pyramid.levels[index], selection.axes, bounds) <= budget) {
      return index;
    }
  }
  return pyramid.levels.length - 1;
}

export function sourceChanged(
  next?: Data,
  prev?: Data,
): boolean {
  return (
    next?.url !== prev?.url ||
    next?.urlTemplate !== prev?.urlTemplate ||
    next?.fetch !== prev?.fetch ||
    next?.pyramid !== prev?.pyramid
  );
}

/**
 * Resolve a `Data` source to a concrete URL.
 *
 * If `urlTemplate` is set, substitutes `{url}` plus every key in `vars`
 * (with values stringified). Otherwise falls back to `url`. Throws when
 * neither is defined. The single substitution path used by tile fetchers,
 * surface loaders, and shape loaders.
 */
export function resolveDataUrl(
  source  : Pick<Data, "url" | "urlTemplate">,
  vars?   : Record<string, string | number | undefined>,
): string {
  if (source.urlTemplate) {
    let url = source.urlTemplate.replace("{url}", source.url ?? "");
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) continue;
        url = url.replace(`{${key}}`, String(value));
      }
    }
    return url;
  }
  if (source.url) return source.url;
  throw new Error("DataSource must have either url, urlTemplate, or fetch");
}

function buildTileUrl(
  source    : Data,
  coord     : TileCoord,
  selection : Record<string, number>,
): string {
  const [x, y, z] = coord.position;
  return resolveDataUrl(source, {
    level: coord.level,
    x,
    y,
    z: z ?? 0,
    ...selection,
  });
}

// ============================================================================
// TILE POOL
// ============================================================================

export function tileId(coord: TileCoord): string {
  return `${coord.level}:${coord.position.join(",")}`;
}

export interface TilePoolConfig {
  device          : GPUDevice;
  /** Maximum storage-chunk dimensions in texels. Use depth=1 for 2D tiles. */
  slotSize        : Vec3;
  /** Texture format (default: "r16float") */
  format?         : GPUTextureFormat;
  /** Bytes per texel for the format (default: 2 for r16float) */
  bytesPerTexel?  : number;
  /** Optional label prefix for GPU resources */
  label?          : string;
  /** Optional slot cap (default: 128 MiB aggregate estimate, bounded by GPU limits) */
  maxPoolSize?    : number;
}

/**
 * Layer-side declaration of "I am a tiled image; allocate a pool of this shape".
 * Layers return this from `getTileSpec()`; the view-side LayerRenderer creates a
 * `TilePool` (and the surrounding `TileManager`) from it. Strictly data-side —
 * layers themselves never touch the GPU.
 */
export interface TileSpec {
  slotSize        : Vec3;
  /** Coarsest pyramid level used for the first visible frame. */
  initialLevel    : number;
  format?         : GPUTextureFormat;
  bytesPerTexel?  : number;
  label?          : string;
  maxPoolSize?    : number;
}

/** View-derived inputs for automatic level selection and visible tile planning. */
export interface TileViewport {
  /** Visible normalized data bounds in layer-local view-axis order. */
  bounds             : TileBounds;
  /** Physical world units represented by one display pixel. */
  worldUnitsPerPixel : number;
  /** Maximum visible storage chunks supported by the renderer cache. */
  tileBudget         : number;
  /** Internal coarse-first override; omitted for automatic selection. */
  level?             : number;
}

/**
 * One frame's tile request from a layer. Returned by `BaseLayer.planTiles()`.
 * Renderer interprets this against its `TileManager` to manage residency.
 */
export interface TileFramePlan<T extends TilePlacement = TilePlacement> {
  plan       : TilePlan<T>;
  loader     : TileLoader<T>;
}


export class TileLoadQueue<T extends { id: string }> {
  private desiredTiles  = new Set<string>();
  private pendingTiles  : T[] = [];
  private loadingTiles  = new Set<string>();
  private inFlightLoads = 0;
  private generation    = 0;

  constructor(private readonly maxConcurrentLoads = 4) {}

  get currentGeneration(): number {
    return this.generation;
  }

  isLoading(id: string): boolean {
    return this.loadingTiles.has(id);
  }

  shouldAccept(id: string, generation: number): boolean {
    return generation === this.generation && this.desiredTiles.has(id);
  }

  setDesired(desiredIds: Iterable<string>, pendingTiles: T[]): void {
    this.desiredTiles = new Set(desiredIds);
    this.pendingTiles = pendingTiles;
  }

  reset(): void {
    this.generation++;
    this.desiredTiles.clear();
    this.pendingTiles = [];
    this.loadingTiles.clear();
  }

  finish(id: string): void {
    this.loadingTiles.delete(id);
    this.inFlightLoads = Math.max(0, this.inFlightLoads - 1);
  }

  pump(
    canStart  : (tile: T) => boolean,
    startLoad : (tile: T, generation: number) => void,
  ): void {
    while (this.inFlightLoads < this.maxConcurrentLoads && this.pendingTiles.length > 0) {
      const nextIndex = this.pendingTiles.findIndex((tile) => (
        !this.loadingTiles.has(tile.id) &&
        this.desiredTiles.has(tile.id) &&
        canStart(tile)
      ));

      if (nextIndex < 0) return;

      const [tile] = this.pendingTiles.splice(nextIndex, 1);
      this.loadingTiles.add(tile.id);
      this.inFlightLoads++;
      startLoad(tile, this.generation);
    }
  }
}

/** Region stride: 20 floats = 80 bytes per slot */
const REGION_STRIDE = 80;

/**
 * Unified 3D tile pool. Manages a pre-allocated 3D texture where each
 * "slot" holds one tile. 2D tiles use depth=1 (same code path).
 *
 * Region per slot: start/scale/bias/tex_offset/tex_scale (20 floats = 80 bytes).
 */
export class TilePool {
  readonly texture      : GPUTexture;
  readonly indexBuffer  : GPUBuffer;
  readonly readyBuffer  : GPUBuffer;
  readonly regionBuffer : GPUBuffer;

  private nextSlot    = 1; // slot 0 = placeholder
  private tileMap     = new Map<string, number>();
  private slotToTile  = new Map<number, string>();

  readonly poolSize               : number;
  readonly invPoolSize            : number;
  readonly device                 : GPUDevice;
  private readonly format         : GPUTextureFormat;
  private readonly bytesPerTexel  : number;
  readonly slotSize               : Vec3;
  private readonly poolLayout     : Vec3;

  constructor(config: TilePoolConfig) {
    this.device         = config.device;
    this.slotSize       = config.slotSize;
    this.format         = config.format ?? "r16float";
    this.bytesPerTexel  = config.bytesPerTexel ?? 2;

    const label       = config.label ?? "TilePool";
    const maxTexSize  = config.device.limits.maxTextureDimension3D;
    const capX = Math.floor(maxTexSize / this.slotSize[0]);
    const capY = Math.floor(maxTexSize / this.slotSize[1]);
    const capZ = Math.floor(maxTexSize / Math.max(1, this.slotSize[2]));
    if (capX < 1 || capY < 1 || capZ < 1) {
      throw new Error(`Storage chunk ${this.slotSize.join("x")} exceeds WebGPU 3D texture limits`);
    }

    const tileBytes        = this.slotSize[0] * this.slotSize[1] * this.slotSize[2] * this.bytesPerTexel;
    const perSlotBytes     = tileBytes + REGION_STRIDE + 12;
    const defaultPoolSize  = Math.max(2, Math.floor((128 * 1024 * 1024) / perSlotBytes));
    const storageSlotCap   = Math.floor(config.device.limits.maxStorageBufferBindingSize / REGION_STRIDE);
    const bufferSlotCap    = Math.floor(config.device.limits.maxBufferSize / REGION_STRIDE);
    if (config.maxPoolSize !== undefined && config.maxPoolSize < 2) {
      throw new Error("Tile pool maxPoolSize must allow a placeholder and one data slot");
    }
    const requestedSlots   = Number.isFinite(config.maxPoolSize)
      ? Math.floor(config.maxPoolSize!)
      : defaultPoolSize;
    const desiredSlots     = Math.min(
      requestedSlots,
      capX * capY * capZ,
      storageSlotCap,
      bufferSlotCap,
    );
    if (desiredSlots < 2) {
      throw new Error("WebGPU limits cannot fit a placeholder and one storage chunk");
    }
    const poolLayout: Vec3 = [1, 1, 1];
    const axisCaps: Vec3 = [capX, capY, capZ];
    let poolSize = 1;
    while (true) {
      let selectedAxis = -1;
      for (let axis = 0; axis < 3; axis++) {
        if (poolLayout[axis] >= axisCaps[axis]) continue;
        const nextSize = (poolSize / poolLayout[axis]) * (poolLayout[axis] + 1);
        if (nextSize > desiredSlots) continue;
        if (selectedAxis < 0 || poolLayout[axis] < poolLayout[selectedAxis]) {
          selectedAxis = axis;
        }
      }
      if (selectedAxis < 0) break;
      poolSize = (poolSize / poolLayout[selectedAxis]) * (poolLayout[selectedAxis] + 1);
      poolLayout[selectedAxis]++;
    }
    const [x, y, z] = poolLayout;

    this.poolLayout   = [x, y, z];
    this.poolSize     = poolSize;
    this.invPoolSize  = 1 / this.poolSize;

    const textureSize: Vec3 = [
      x * this.slotSize[0],
      y * this.slotSize[1],
      z * Math.max(1, this.slotSize[2]),
    ];

    this.texture = config.device.createTexture({
      label     : `${label} Texture`,
      size      : textureSize,
      format    : this.format,
      dimension : "3d",
      usage     : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.indexBuffer = config.device.createBuffer({
      label : `${label} Index Buffer`,
      size  : Math.max(this.poolSize * 2 * 4, 8),
      usage : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.readyBuffer = config.device.createBuffer({
      label : `${label} Ready Buffer`,
      size  : Math.max(this.poolSize * 4, 4),
      usage : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.regionBuffer = config.device.createBuffer({
      label : `${label} Region Buffer`,
      size  : Math.max(this.poolSize * REGION_STRIDE, REGION_STRIDE),
      usage : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.device.queue.writeBuffer(this.readyBuffer, 0, new Uint32Array(this.poolSize));
    this.initPlaceholderTile();
  }

  private initPlaceholderTile(): void {
    const texSize: Vec3 = [...this.slotSize];
    const numTexels     = texSize[0] * texSize[1] * texSize[2];
    const data          = new ArrayBuffer(numTexels * this.bytesPerTexel);

    if (this.format === "r16float") {
      const view    = new DataView(data);
      const float16 = floatToFloat16(0.0);
      for (let i = 0; i < numTexels; i++) {
        view.setUint16(i * 2, float16, true);
      }
    }

    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: 0, y: 0, z: 0 } },
      data,
      { bytesPerRow: texSize[0] * this.bytesPerTexel, rowsPerImage: texSize[1] },
      texSize,
    );

    this.device.queue.writeBuffer(this.regionBuffer, 0, new Float32Array([
      0, 0, 0, 0,
      1, 1, 1, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      1 / this.poolLayout[0], 1 / this.poolLayout[1], 1 / this.poolLayout[2], 0,
    ]));

    this.device.queue.writeBuffer(this.readyBuffer, 0, new Uint32Array([1]));
  }

  get capacity(): number { return this.poolSize; }

  getSlot(tileId: string): number | undefined {
    return this.tileMap.get(tileId);
  }

  reset(): void {
    this.tileMap.clear();
    this.slotToTile.clear();
    this.nextSlot = 1;
    this.device.queue.writeBuffer(this.readyBuffer, 0, new Uint32Array(this.poolSize));
    this.device.queue.writeBuffer(this.regionBuffer, 0, new Uint8Array(this.poolSize * REGION_STRIDE));
  }

  allocateSlot(tileId: string): number {
    const existing = this.tileMap.get(tileId);
    if (existing !== undefined) return existing;

    const slot = this.nextSlot;
    this.nextSlot++;
    if (this.nextSlot >= this.poolSize) this.nextSlot = 1;

    const evicted = this.slotToTile.get(slot);
    if (evicted) this.tileMap.delete(evicted);

    this.tileMap.set(tileId, slot);
    this.slotToTile.set(slot, tileId);
    this.device.queue.writeBuffer(this.readyBuffer, slot * 4, new Uint32Array([0]));
    return slot;
  }

  uploadTile(
    slot    : number,
    data    : ArrayBuffer,
    region  : { start: Vec3; size: Vec3 },
    tileSize: Vec3,
  ): void {
    const tilesPerLayer = this.poolLayout[0] * this.poolLayout[1];
    const zTile         = Math.floor(slot / tilesPerLayer);
    const remainder     = slot % tilesPerLayer;
    const yTile         = Math.floor(remainder / this.poolLayout[0]);
    const xTile         = remainder % this.poolLayout[0];

    const origin = {
      x: xTile * this.slotSize[0],
      y: yTile * this.slotSize[1],
      z: zTile * this.slotSize[2],
    };

    const expectedBytes = tileSize[0] * tileSize[1] * tileSize[2] * this.bytesPerTexel;
    if ((data?.byteLength ?? 0) < expectedBytes) {
      console.warn(`[TilePool] uploadTile: slot=${slot} expected ${expectedBytes} bytes, got ${data?.byteLength ?? 0}. Skipping.`);
      const id = this.slotToTile.get(slot);
      if (id) {
        this.tileMap.delete(id);
        this.slotToTile.delete(slot);
      }
      return;
    }

    this.device.queue.writeTexture(
      { texture: this.texture, origin },
      data,
      { bytesPerRow: tileSize[0] * this.bytesPerTexel, rowsPerImage: tileSize[1] },
      tileSize,
    );

    const poolTexSize = [
      this.poolLayout[0] * this.slotSize[0],
      this.poolLayout[1] * this.slotSize[1],
      this.poolLayout[2] * this.slotSize[2],
    ];
    const texOffset = [
      origin.x / poolTexSize[0],
      origin.y / poolTexSize[1],
      origin.z / poolTexSize[2],
    ];
    const texScale = [
      tileSize[0] / poolTexSize[0],
      tileSize[1] / poolTexSize[1],
      tileSize[2] / poolTexSize[2],
    ];
    const bias = [
      -region.start[0] / region.size[0],
      -region.start[1] / region.size[1],
      -region.start[2] / region.size[2],
    ];
    const scale: Vec3 = [1 / region.size[0], 1 / region.size[1], 1 / region.size[2]];

    const regionData = new Float32Array([
      region.start[0], region.start[1], region.start[2], 0,
      scale[0], scale[1], scale[2], 0,
      bias[0], bias[1], bias[2], 0,
      texOffset[0], texOffset[1], texOffset[2], 0,
      texScale[0], texScale[1], texScale[2], 0,
    ]);
    this.device.queue.writeBuffer(this.regionBuffer, slot * REGION_STRIDE, regionData);
    this.device.queue.writeBuffer(this.readyBuffer, slot * 4, new Uint32Array([1]));
  }

  destroy(): void {
    this.texture.destroy();
    this.indexBuffer.destroy();
    this.readyBuffer.destroy();
    this.regionBuffer.destroy();
    this.tileMap.clear();
    this.slotToTile.clear();
  }
}

// ============================================================================
// TILE MANAGER
// ============================================================================

/**
 * Per-tile fetch strategy used by `TileManager.loadOne`.
 */
export interface TileLoader<T extends { id: string }> {
  fetch(req: T): Promise<ArrayBuffer>;
}

// ----------------------------------------------------------------------------
// Tile-grid planner
// ----------------------------------------------------------------------------

/**
 * A tile placed at a planner grid cell. Carries the load `id`, its grid
 * index, voxel-space position, and pyramid level. Concrete layers may
 * extend `T` with extra fields they need at fetch time.
 */
export interface TilePlacement {
  id        : string;
  gridIdx   : number;
  voxelPos  : number[];
  level     : number;
  chunkSize : Vec3;
  region    : { start: Vec3; size: Vec3 };
}

export interface TilePlan<T extends TilePlacement> {
  /** Visible viewport origin in normalized data-space (length = gridDim). */
  viewportOrigin  : number[];
  /** Visible viewport size in normalized data-space (length = gridDim). */
  viewportSize    : number[];
  /** First visible storage-chunk coordinate (length = gridDim). */
  gridOrigin      : number[];
  /** Visible storage-chunk count per axis (length = gridDim). */
  gridShape       : number[];
  /** Per-axis tile size in normalized [0,1] (length = gridDim). */
  tileNormSize    : number[];
  /** Generated visible tile descriptors, x-fastest. */
  tiles           : T[];
  /** Dimensionality of the visible grid. */
  gridDim         : 2 | 3;
}

/**
 * Plan every storage chunk intersecting normalized viewport bounds.
 * `makeTile` can remap view axes and attach layer-specific request metadata.
 */
export function planTiles<T extends TilePlacement>(opts: {
  bounds      : TileBounds;
  chunkSize   : readonly number[];
  resSize     : readonly number[];
  gridDim     : 2 | 3;
  level       : number;
  /** Construct a tile placement; layer can attach extra fields. */
  makeTile    : (
    gridIdx  : number,
    voxelPos : number[],
    level    : number,
    region   : { start: number[]; size: number[] },
  ) => T;
}): TilePlan<T> {
  const { bounds, chunkSize, resSize, gridDim, level, makeTile } = opts;
  const tileNormSize  = new Array<number>(gridDim);
  const gridOrigin    = new Array<number>(gridDim);
  const gridShape     = new Array<number>(gridDim);
  const viewportOrigin = new Array<number>(gridDim);
  const viewportSize   = new Array<number>(gridDim);
  for (let axis = 0; axis < gridDim; axis++) {
    const size        = Math.max(1, resSize[axis]);
    const chunk       = Math.max(1, chunkSize[axis]);
    const lower       = Math.max(0, Math.min(1, bounds.min[axis] ?? 0));
    const upper       = Math.max(lower, Math.min(1, bounds.max[axis] ?? 1));
    const firstChunk  = Math.floor((lower * size) / chunk);
    const intersects  = upper > lower;
    const lastChunk   = intersects
      ? Math.max(firstChunk, Math.ceil((upper * size) / chunk) - 1)
      : firstChunk - 1;
    tileNormSize[axis]  = chunk / size;
    gridOrigin[axis]    = firstChunk;
    gridShape[axis]     = Math.max(0, lastChunk - firstChunk + 1);
    viewportOrigin[axis] = lower;
    viewportSize[axis]   = upper - lower;
  }

  const tiles: T[] = [];
  if (gridDim === 3) {
    for (let z = 0; z < gridShape[2]; z++) {
      for (let y = 0; y < gridShape[1]; y++) {
        for (let x = 0; x < gridShape[0]; x++) {
          const gridIdx = z * gridShape[0] * gridShape[1] + y * gridShape[0] + x;
          const voxelPos = [
            (gridOrigin[0] + x) * chunkSize[0],
            (gridOrigin[1] + y) * chunkSize[1],
            (gridOrigin[2] + z) * chunkSize[2],
          ];
          const region = {
            start: voxelPos.map((value, axis) => value / resSize[axis]),
            size : tileNormSize.slice(),
          };
          tiles.push(makeTile(gridIdx, voxelPos, level, region));
        }
      }
    }
  } else {
    for (let y = 0; y < gridShape[1]; y++) {
      for (let x = 0; x < gridShape[0]; x++) {
        const gridIdx = y * gridShape[0] + x;
        const voxelPos = [
          (gridOrigin[0] + x) * chunkSize[0],
          (gridOrigin[1] + y) * chunkSize[1],
        ];
        const region = {
          start: voxelPos.map((value, axis) => value / resSize[axis]),
          size : tileNormSize.slice(),
        };
        tiles.push(makeTile(gridIdx, voxelPos, level, region));
      }
    }
  }

  return {
    viewportOrigin,
    viewportSize,
    gridOrigin,
    gridShape,
    tileNormSize,
    tiles,
    gridDim,
  };
}

/**
 * `TileManager<T>` — composition helper held by tileable layers.
 *
 * Owns a `TilePool` + `TileLoadQueue` + loaded placement map and a shared
 * `pump`/`loadOne` runner. Concrete layers compute the per-frame visible
 * `TilePlan` and call `commit(plan, loader)` to push it onto the GPU + load queue.
 */
export class TileManager<T extends TilePlacement> {
  pool?                 : TilePool;
  readonly queue        : TileLoadQueue<T>;
  readonly loadedTiles  = new Map<string, T>();
  private loader?       : TileLoader<T>;
  private onUpdate?     : () => void;
  private desiredTiles  = new Set<string>();

  constructor(maxConcurrent = 4) {
    this.queue = new TileLoadQueue<T>(maxConcurrent);
  }

  /** Synchronous pool construction. Idempotent. */
  init(config: TilePoolConfig): void {
    if (this.pool) return;
    this.pool = new TilePool(config);
  }

  setLoader(loader: TileLoader<T>): void {
    this.loader = loader;
  }

  setOnUpdate(cb?: () => void): void {
    this.onUpdate = cb;
  }

  /** Whether at least one tile in the current visible plan is resident. */
  hasVisibleTile(): boolean {
    const pool = this.pool;
    if (!pool) return false;
    for (const id of this.desiredTiles) {
      if (pool.getSlot(id) !== undefined) return true;
    }
    return false;
  }

  /**
  * Push a `planTiles` result onto the GPU + load queue:
  *   1. Write index buffer (current + spatial fallback per visible chunk).
  *   2. Filter tiles needing a fetch.
  *   3. Sort by distance from the visible viewport center.
   *   4. Bind per-frame loader, set the desired set, pump the queue.
   *
   * Layers must call `setOnUpdate`/`setLoader` once at construction; `commit`
   * accepts a fresh `loader` per call because the closures usually capture
   * source / selection / sliceIndex that change between frames.
   */
  commit(
    plan    : TilePlan<T>,
    loader  : TileLoader<T>,
  ): void {
    const pool = this.pool;
    if (!pool) return;

    const cellCount  = plan.tiles.length;
    if (cellCount >= pool.capacity) {
      throw new Error(
        `Visible tile count ${cellCount} exceeds tile cache budget ${pool.capacity - 1}`,
      );
    }
    const indices    = new Uint32Array(cellCount * 2);
    for (const tile of plan.tiles) {
      const slot         = pool.getSlot(tile.id) ?? 0;
      const fallbackSlot = slot === 0 ? this.findCoveringSlot(tile, pool) : slot;
      indices[tile.gridIdx * 2]     = slot;
      indices[tile.gridIdx * 2 + 1] = fallbackSlot;
    }
    if (indices.byteLength > 0) {
      pool.device.queue.writeBuffer(pool.indexBuffer, 0, indices);
    }

    const center = plan.viewportOrigin.map((origin, axis) => (
      origin + plan.viewportSize[axis] / 2
    ));
    const tilesToLoad = plan.tiles
      .filter((tile) => {
        const hasSlot = pool.getSlot(tile.id) !== undefined;
        if (!hasSlot) this.loadedTiles.delete(tile.id);
        return !hasSlot && !this.queue.isLoading(tile.id);
      })
      .sort((a, b) => (
        this.distanceFromCenter(a, center, plan.gridDim) -
        this.distanceFromCenter(b, center, plan.gridDim)
      ));

    this.setLoader(loader);
    this.desiredTiles = new Set(plan.tiles.map((tile) => tile.id));
    this.queue.setDesired(this.desiredTiles, tilesToLoad);
    this.pump();
  }

  /** Schedule any pending tile loads up to the queue's concurrency limit. */
  pump(): void {
    const pool   = this.pool;
    const loader = this.loader;
    if (!pool || !loader) return;
    this.queue.pump(
      (tile) => pool.getSlot(tile.id) === undefined,
      (tile, generation) => {
        void this.loadOne(tile, generation, pool, loader);
      },
    );
  }

  private async loadOne(
    tile: T,
    generation: number,
    pool: TilePool,
    loader: TileLoader<T>,
  ): Promise<void> {
    try {
      const data = await loader.fetch(tile);
      if (!this.queue.shouldAccept(tile.id, generation)) return;
      if (pool.getSlot(tile.id) !== undefined) return;
      const slot = pool.allocateSlot(tile.id);
      if (slot !== -1) {
        pool.uploadTile(slot, data, tile.region, tile.chunkSize);
      }
      this.loadedTiles.set(tile.id, tile);
      this.onUpdate?.();
    } catch (e) {
      console.warn(`[TileManager] Failed to load tile ${tile.id}:`, e);
      this.loadedTiles.delete(tile.id);
    } finally {
      this.queue.finish(tile.id);
      this.pump();
    }
  }

  /** Drop all in-flight loads, cached placements, desired IDs, and pool residency. */
  reset(): void {
    this.queue.reset();
    this.loadedTiles.clear();
    this.desiredTiles.clear();
    this.pool?.reset();
  }

  private findCoveringSlot(tile: T, pool: TilePool): number {
    const center: Vec3 = [
      tile.region.start[0] + tile.region.size[0] / 2,
      tile.region.start[1] + tile.region.size[1] / 2,
      tile.region.start[2] + tile.region.size[2] / 2,
    ];
    let bestSlot = 0;
    let bestVolume = Infinity;
    for (const loaded of this.loadedTiles.values()) {
      const slot = pool.getSlot(loaded.id);
      if (slot === undefined) continue;
      const { start, size } = loaded.region;
      const contains = center.every((value, axis) => (
        value >= start[axis] && value <= start[axis] + size[axis]
      ));
      if (!contains) continue;
      const volume = size[0] * size[1] * size[2];
      if (volume < bestVolume) {
        bestVolume = volume;
        bestSlot = slot;
      }
    }
    return bestSlot;
  }

  private distanceFromCenter(tile: T, center: number[], gridDim: 2 | 3): number {
    let distance = 0;
    for (let axis = 0; axis < gridDim; axis++) {
      const tileCenter = tile.region.start[axis] + tile.region.size[axis] / 2;
      distance += Math.abs(tileCenter - center[axis]);
    }
    return distance;
  }
}

export function floatToFloat16(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = value;
  const f     = int32View[0];
  const sign  = (f >> 31) & 0x0001;
  const exp   = (f >> 23) & 0x00ff;
  const frac  = f & 0x007fffff;
  if (exp === 0) return 0;
  if (exp === 0xff) return (sign << 15) | 0x7c00;
  const newE = exp - 127 + 15;
  if (newE >= 31) return (sign << 15) | 0x7c00;
  if (newE <= 0) return 0;
  return (sign << 15) | (newE << 10) | (frac >> 13);
}
