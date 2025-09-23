/**
 * Tile — GPU texture cache for tiled data
 *
 * Manages a pre-allocated 3D texture where each "slot" holds one tile.
 * 2D tiles use depth=1 (same code path).
 */

import type { Data, Vec3 } from "../types";

// ============================================================================
// TILE TYPES
// ============================================================================

export interface TileCoord {
  level     : number;
  position  : number[]; // [x, y] for 2D, [x, y, z] for 3D
}

/** Tile source — describes a tiled dataset for the tile pool / loader */
export interface TileSource {
  size       : Vec3;
  tileSize   : Vec3;
  levelRange : [number, number];
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

/**
 * Per-level voxel scale relative to level 0 (e.g. [2, 2, 2] at level 1).
 * Defaults to a uniform power-of-two pyramid when `levelScales` is absent.
 */
export function getPyramidLevelScale(
  level         : number,
  levelScales?  : readonly Vec3[],
): Vec3 {
  const configured = levelScales?.[level];
  if (configured) return configured;
  const fallback = 2 ** level;
  return [fallback, fallback, fallback];
}

/** Clamp a pyramid level into the inclusive [min,max] range. */
export function clampPyramidLevel(
  level       : number,
  levelRange  : readonly [number, number],
): number {
  return Math.max(levelRange[0], Math.min(levelRange[1], level));
}

/**
 * Choose the coarsest pyramid level whose sampling density still satisfies
 * `effectiveScale`. With no `levelScales`, behaves as a uniform power-of-two
 * pyramid: `levelRange[1] - floor(log2(effectiveScale))`.
 */
export function pickPyramidLevel(
  effectiveScale  : number,
  levelRange      : readonly [number, number],
  levelScales?    : readonly Vec3[],
): number {
  let bestLevel = levelRange[1];
  const coarsestScale   = getPyramidLevelScale(bestLevel, levelScales);
  const coarsestMetric  = Math.max(coarsestScale[0], coarsestScale[1], coarsestScale[2]);
  const desiredMetric   = coarsestMetric / Math.max(effectiveScale, 1e-6);
  for (let level = levelRange[1]; level >= levelRange[0]; level--) {
    const s = getPyramidLevelScale(level, levelScales);
    if (Math.max(s[0], s[1], s[2]) >= desiredMetric) {
      bestLevel = level;
    } else {
      break;
    }
  }
  return bestLevel;
}

/**
 * Resolve a pyramid level given mode + auto/manual hints. In manual mode,
 * clamps `resolutionLevel` (or `fallbackLevel`) to range. In auto mode,
 * delegates to `pickPyramidLevel`.
 */
export function resolvePyramidLevel(
  effectiveScale  : number,
  levelRange      : readonly [number, number],
  opts: {
    resolutionMode?   : "auto" | "manual";
    resolutionLevel?  : number;
    levelScales?      : readonly Vec3[];
    fallbackLevel?    : number;
  } = {},
): number {
  if (opts.resolutionMode === "manual") {
    const requested = opts.resolutionLevel ?? opts.fallbackLevel ?? levelRange[0];
    return clampPyramidLevel(Math.round(requested), levelRange);
  }
  return pickPyramidLevel(effectiveScale, levelRange, opts.levelScales);
}

export function sourceChanged(
  next?: Pick<Data, "url" | "urlTemplate">,
  prev?: Pick<Data, "url" | "urlTemplate">,
): boolean {
  return sourceKey(next) !== sourceKey(prev);
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

function sourceKey(source?: Pick<Data, "url" | "urlTemplate">): string {
  return source?.urlTemplate ?? source?.url ?? "";
}

// ============================================================================
// TILE POOL
// ============================================================================

export function tileId(coord: TileCoord): string {
  return `${coord.level}:${coord.position.join(",")}`;
}

export interface TilePoolConfig {
  device          : GPUDevice;
  /** Tile dimensions in texels: [width, height, depth]. Use depth=1 for 2D tiles. */
  tileSize        : Vec3;
  /** Optional explicit grid cell count. Defaults to 9 for 2D tiles and 27 for 3D tiles. */
  gridCells?      : 9 | 27;
  /** Texture format (default: "r16float") */
  format?         : GPUTextureFormat;
  /** Bytes per texel for the format (default: 2 for r16float) */
  bytesPerTexel?  : number;
  /** Optional label prefix for GPU resources */
  label?          : string;
  /** Maximum pool size cap (default: computed from GPU limits) */
  maxPoolSize?    : number;
}

/**
 * Layer-side declaration of "I am a tiled image; allocate a pool of this shape".
 * Layers return this from `getTileSpec()`; the view-side LayerRenderer creates a
 * `TilePool` (and the surrounding `TileManager`) from it. Strictly data-side —
 * layers themselves never touch the GPU.
 */
export interface TileSpec {
  tileSize        : Vec3;
  gridCells?      : 9 | 27;
  format?         : GPUTextureFormat;
  bytesPerTexel?  : number;
  label?          : string;
  maxPoolSize?    : number;
}

/**
 * One frame's tile request from a layer. Returned by `BaseLayer.planTiles()`.
 * Renderer interprets this against its `TileManager` to manage residency.
 */
export interface TileFramePlan<T extends TilePlacement = TilePlacement> {
  plan       : TilePlan<T>;
  loader     : TileLoader<T>;
  inBounds?  : (tile: T) => boolean;
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

  /** Grid cells: 9 (3×3×1) for 2D tiles, 27 (3×3×3) for 3D tiles */
  readonly grid                   : number;
  readonly poolSize               : number;
  readonly invPoolSize            : number;
  readonly device                 : GPUDevice;
  private readonly format         : GPUTextureFormat;
  private readonly bytesPerTexel  : number;
  readonly tileSize               : Vec3;
  private readonly poolLayout     : Vec3;

  constructor(config: TilePoolConfig) {
    this.device         = config.device;
    this.tileSize       = config.tileSize;
    this.format         = config.format ?? "r16float";
    this.bytesPerTexel  = config.bytesPerTexel ?? 2;
    this.grid           = config.gridCells ?? (this.tileSize[2] === 1 ? 9 : 27);

    const label       = config.label ?? "TilePool";
    const maxTexSize  = config.device.limits.maxTextureDimension3D;
    const userMaxPool = config.maxPoolSize ?? Infinity;

    const capX = Math.floor(maxTexSize / this.tileSize[0]);
    const capY = Math.floor(maxTexSize / this.tileSize[1]);
    const capZ = Math.floor(maxTexSize / Math.max(1, this.tileSize[2]));
    // Default capacity = grid × 3 history frames (covers current viewport plus
    // two frames worth of in-flight loads / hysteresis).
    const desiredSlots = Number.isFinite(userMaxPool) ? userMaxPool : this.grid * 3;

    const n = Math.max(1, Math.ceil(Math.cbrt(desiredSlots)));
    const x = Math.min(n, capX);
    const y = Math.min(n, capY);
    const z = Math.min(n, capZ);

    this.poolLayout   = [x, y, z];
    this.poolSize     = x * y * z;
    this.invPoolSize  = 1 / this.poolSize;

    const textureSize: Vec3 = [
      x * this.tileSize[0],
      y * this.tileSize[1],
      z * Math.max(1, this.tileSize[2]),
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
      size  : this.grid * 2 * 4,
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
    const texSize: Vec3 = [...this.tileSize];
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

  get gridSize(): number { return this.grid; }
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
    region  : { start: number[]; scale: number[] },
  ): void {
    const tilesPerLayer = this.poolLayout[0] * this.poolLayout[1];
    const zTile         = Math.floor(slot / tilesPerLayer);
    const remainder     = slot % tilesPerLayer;
    const yTile         = Math.floor(remainder / this.poolLayout[0]);
    const xTile         = remainder % this.poolLayout[0];

    const origin = {
      x: xTile * this.tileSize[0],
      y: yTile * this.tileSize[1],
      z: zTile * this.tileSize[2],
    };

    const expectedBytes = this.tileSize[0] * this.tileSize[1] * this.tileSize[2] * this.bytesPerTexel;
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
      { bytesPerRow: this.tileSize[0] * this.bytesPerTexel, rowsPerImage: this.tileSize[1] },
      this.tileSize,
    );

    const poolTexSize = [
      this.poolLayout[0] * this.tileSize[0],
      this.poolLayout[1] * this.tileSize[1],
      this.poolLayout[2] * this.tileSize[2],
    ];
    const texOffset = [
      origin.x / poolTexSize[0],
      origin.y / poolTexSize[1],
      origin.z / poolTexSize[2],
    ];
    const texScale = [
      this.tileSize[0] / poolTexSize[0],
      this.tileSize[1] / poolTexSize[1],
      this.tileSize[2] / poolTexSize[2],
    ];
    const bias = [
      -(region.start[0] ?? 0) * (region.scale[0] ?? 1),
      -(region.start[1] ?? 0) * (region.scale[1] ?? 1),
      -(region.start[2] ?? 0) * (region.scale[2] ?? 1),
    ];

    const regionData = new Float32Array([
      region.start[0] ?? 0, region.start[1] ?? 0, region.start[2] ?? 0, 0,
      region.scale[0] ?? 1, region.scale[1] ?? 1, region.scale[2] ?? 1, 0,
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
 * Per-tile fetch + region strategy used by `TileManager.loadOne`.
 * Layers (Volume, Slice) supply this to express how a tile resolves into
 * bytes and a viewport-region descriptor for `TilePool.uploadTile`.
 */
export interface TileLoader<T extends { id: string }> {
  fetch(req: T)  : Promise<ArrayBuffer>;
  region(req: T) : { start: number[]; scale: number[] };
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
}

export interface TilePlan<T extends TilePlacement> {
  /** Viewport origin in normalized data-space (length = gridDim). */
  viewportOrigin  : number[];
  /** Viewport size in normalized data-space (length = gridDim). */
  viewportSize    : number[];
  /** Center bucket coords (length = gridDim). */
  bucket          : number[];
  /** Per-axis tile size in normalized [0,1] (length = gridDim). */
  tileNormSize    : number[];
  /** Generated tile descriptors. Length = 3 ** gridDim. */
  tiles           : T[];
  /** Dimensionality of the planar grid: 2 (3×3) or 3 (3×3×3). */
  gridDim         : 2 | 3;
}

/**
 * Plan a 3×3 (gridDim=2) or 3×3×3 (gridDim=3) tile grid centered on `target`.
 * Computes the viewport that exposes the grid's data range, and emits one tile
 * placement per cell. `makeTile` is invoked with the gridIdx and voxel-space
 * position for each cell so layers can extend the placement shape.
 */
export function planTiles<T extends TilePlacement>(opts: {
  target      : readonly number[];
  tileSize    : readonly number[];
  resSize     : readonly number[];
  gridDim     : 2 | 3;
  level       : number;
  /** Min bucket clamp (defaults to 1 so dx=-1 stays non-negative). */
  minBucket?  : number;
  /** Construct a tile placement; layer can attach extra fields. */
  makeTile    : (gridIdx: number, voxelPos: number[], level: number) => T;
}): TilePlan<T> {
  const { target, tileSize, resSize, gridDim, level, makeTile } = opts;
  const minBucket  = opts.minBucket ?? 1;

  const tileNormSize = new Array<number>(gridDim);
  const bucket       = new Array<number>(gridDim);
  const viewportOrigin = new Array<number>(gridDim);
  const viewportSize   = new Array<number>(gridDim);
  for (let i = 0; i < gridDim; i++) {
    tileNormSize[i]   = tileSize[i] / resSize[i];
    bucket[i]         = Math.max(minBucket, Math.floor(target[i] / tileNormSize[i]));
    viewportOrigin[i] = (bucket[i] - 1) * tileNormSize[i];
    viewportSize[i]   = 3 * tileNormSize[i];
  }

  const tiles: T[] = [];
  if (gridDim === 3) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gridIdx = (dz + 1) * 9 + (dy + 1) * 3 + (dx + 1);
          const voxelPos = [
            (bucket[0] + dx) * tileSize[0],
            (bucket[1] + dy) * tileSize[1],
            (bucket[2] + dz) * tileSize[2],
          ];
          tiles.push(makeTile(gridIdx, voxelPos, level));
        }
      }
    }
  } else {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gridIdx = (dy + 1) * 3 + (dx + 1);
        const voxelPos = [
          (bucket[0] + dx) * tileSize[0],
          (bucket[1] + dy) * tileSize[1],
        ];
        tiles.push(makeTile(gridIdx, voxelPos, level));
      }
    }
  }

  return { viewportOrigin, viewportSize, bucket, tileNormSize, tiles, gridDim };
}

/** Manhattan distance from grid center; works for 2D (9 cells) and 3D (27). */
function tileDistanceFromCenter(gridIdx: number, gridDim: 2 | 3): number {
  const x = gridIdx % 3;
  const y = Math.floor(gridIdx / 3) % 3;
  if (gridDim === 2) return Math.abs(x - 1) + Math.abs(y - 1);
  const z = Math.floor(gridIdx / 9);
  return Math.abs(x - 1) + Math.abs(y - 1) + Math.abs(z - 1);
}

/**
 * `TileManager<T>` — composition helper held by tileable layers.
 *
 * Owns a `TilePool` + `TileLoadQueue` + `loadedTiles` eviction set, the per-grid
 * `prevIndices` mapping, and a shared `pump`/`loadOne` runner. Concrete layers
 * compute the per-frame `TilePlan` (level, resSize, makeTile) and call
 * `commit(plan, loader, opts?)` to push the plan onto the GPU + load queue.
 */
export class TileManager<T extends TilePlacement> {
  pool?                 : TilePool;
  readonly queue        : TileLoadQueue<T>;
  readonly loadedTiles  = new Set<string>();
  private loader?       : TileLoader<T>;
  private onUpdate?     : () => void;
  private prevIndices   : number[] = [];

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

  /** Forget the previous-frame slot mapping (e.g. on level / source change). */
  invalidatePrev(): void {
    this.prevIndices = [];
  }

  /**
   * Push a `planTiles` result onto the GPU + load queue:
   *   1. Write index buffer (current + prev slot per grid cell).
   *   2. Filter tiles needing a fetch (in-bounds, no slot, not loading).
   *   3. Sort by Manhattan distance from grid center.
   *   4. Bind per-frame loader, set the desired set, pump the queue.
   *
   * Layers must call `setOnUpdate`/`setLoader` once at construction; `commit`
   * accepts a fresh `loader` per call because the closures usually capture
   * source / selection / sliceIndex that change between frames.
   */
  commit(
    plan    : TilePlan<T>,
    loader  : TileLoader<T>,
    opts?   : { inBounds?: (tile: T) => boolean },
  ): void {
    const pool = this.pool;
    if (!pool) return;

    const cellCount  = plan.tiles.length;
    const indices    = new Uint32Array(cellCount * 2);
    for (const tile of plan.tiles) {
      const slot     = pool.getSlot(tile.id) ?? 0;
      const prevSlot = this.prevIndices[tile.gridIdx] ?? 0;
      indices[tile.gridIdx * 2]     = slot;
      indices[tile.gridIdx * 2 + 1] = prevSlot;
    }
    pool.device.queue.writeBuffer(pool.indexBuffer, 0, indices);
    this.prevIndices = plan.tiles.map((tile) => pool.getSlot(tile.id) ?? 0);

    const inBounds = opts?.inBounds;
    const tilesToLoad = plan.tiles
      .filter((tile) => {
        if (inBounds && !inBounds(tile)) return false;
        const hasSlot = pool.getSlot(tile.id) !== undefined;
        if (!hasSlot) this.loadedTiles.delete(tile.id);
        return !hasSlot && !this.queue.isLoading(tile.id);
      })
      .sort((a, b) => (
        tileDistanceFromCenter(a.gridIdx, plan.gridDim) -
        tileDistanceFromCenter(b.gridIdx, plan.gridDim)
      ));

    this.setLoader(loader);
    this.queue.setDesired(plan.tiles.map((tile) => tile.id), tilesToLoad);
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
        pool.uploadTile(slot, data, loader.region(tile));
      }
      this.loadedTiles.add(tile.id);
      this.onUpdate?.();
    } catch (e) {
      console.warn(`[TileManager] Failed to load tile ${tile.id}:`, e);
      this.loadedTiles.delete(tile.id);
    } finally {
      this.queue.finish(tile.id);
      this.pump();
    }
  }

  /** Drop all in-flight loads, the cache, the prev-slot map, and the pool. */
  reset(): void {
    this.queue.reset();
    this.loadedTiles.clear();
    this.prevIndices = [];
    this.pool?.reset();
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
