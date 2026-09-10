/**
 * Tile pool — GPU texture cache for tiled data.
 *
 * Manages a pre-allocated 3D texture where each "slot" holds one tile.
 * 2D tiles use depth=1 (same code path).
 */

import type { Vec3 } from "../../state/schema";
import type { TileBounds } from "./level";

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
  /** Physical world units represented by one canvas pixel. */
  worldUnitsPerPixel : number;
  /** Renderer sampling scale used for level selection; defaults to canvas scale. */
  selectionUnitsPerPixel?: number;
  /** Maximum visible storage chunks supported by the renderer cache. */
  tileBudget         : number;
  /** Previous view-local automatic level used for hysteresis. */
  currentLevel?      : number;
  /** Internal coarse-first override; omitted after initial promotion. */
  forcedLevel?       : number;
}

/** Region stride: 20 floats = 80 bytes per slot */
const REGION_STRIDE = 80;
/** Two u32 slot references (current + fallback) per spatial grid cell. */
const INDEX_ENTRY_STRIDE = 2 * Uint32Array.BYTES_PER_ELEMENT;

/**
 * Unified 3D tile pool. Manages a pre-allocated 3D texture where each
 * "slot" holds one tile. 2D tiles use depth=1 (same code path).
 *
 * Region per slot: start/scale/bias/tex_offset/tex_scale (20 floats = 80 bytes).
 */
export class TilePool {
  readonly texture      : GPUTexture;
  readonly readyBuffer  : GPUBuffer;
  readonly regionBuffer : GPUBuffer;

  private _indexBuffer : GPUBuffer;
  private indexCapacity: number;
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
  private readonly label          : string;

  constructor(config: TilePoolConfig) {
    this.device         = config.device;
    this.slotSize       = config.slotSize;
    this.format         = config.format ?? "r16float";
    this.bytesPerTexel  = config.bytesPerTexel ?? 2;

    const label       = config.label ?? "TilePool";
    this.label        = label;
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

    this.indexCapacity = this.poolSize;
    this._indexBuffer = config.device.createBuffer({
      label : `${label} Index Buffer`,
      size  : Math.max(this.indexCapacity * INDEX_ENTRY_STRIDE, INDEX_ENTRY_STRIDE),
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
      // floatToFloat16(0.0) === 0x0000 — the half-float bit pattern for zero
      // (the helper itself lives in utils/render/float16.ts; viewer/tile is a
      // leaf module that may not import utils).
      const float16 = 0x0000;
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
  get indexBuffer(): GPUBuffer { return this._indexBuffer; }

  /** Ensure the spatial grid can address every planned cell, resident or not. */
  ensureIndexCapacity(entryCount: number): boolean {
    if (entryCount <= this.indexCapacity) return false;

    const maxBytes = Math.min(
      this.device.limits.maxStorageBufferBindingSize,
      this.device.limits.maxBufferSize,
    );
    const maxEntries = Math.floor(maxBytes / INDEX_ENTRY_STRIDE);
    if (entryCount > maxEntries) {
      throw new Error(
        `Tile index grid requires ${entryCount} entries, exceeding the WebGPU limit of ${maxEntries}`,
      );
    }

    const nextCapacity = Math.min(
      maxEntries,
      Math.max(entryCount, this.indexCapacity * 2),
    );
    const previous = this._indexBuffer;
    this._indexBuffer = this.device.createBuffer({
      label : `${this.label} Index Buffer`,
      size  : nextCapacity * INDEX_ENTRY_STRIDE,
      usage : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.indexCapacity = nextCapacity;
    void this.device.queue.onSubmittedWorkDone().then(() => previous.destroy());
    return true;
  }

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
    this._indexBuffer.destroy();
    this.readyBuffer.destroy();
    this.regionBuffer.destroy();
    this.tileMap.clear();
    this.slotToTile.clear();
  }
}
