/**
 * Tile manager — composition helper held by tileable layers.
 *
 * Owns a `TilePool` + `TileLoadQueue` + loaded placement map and a shared
 * `pump`/`loadOne` runner. Concrete layers compute the per-frame visible
 * `TilePlan` and call `commit(plan, loader)` to push it onto the GPU + load
 * queue.
 */

import { TileLoadQueue } from "./queue";
import { TilePool, type TilePoolConfig } from "./pool";
import type { TilePlacement, TilePlan } from "./planner";

/**
 * Per-tile fetch strategy used by `TileManager.loadOne`.
 */
export interface TileLoader<T extends { id: string }> {
  fetch(req: T): Promise<ArrayBuffer>;
}

export interface TileCommitResult {
  /** Coarsest resident level currently supplying any planned cell. */
  displayedLevel?: number;
}

/**
 * One frame's tile request from a layer. Returned by `BaseLayer.planTiles()`.
 * Renderer interprets this against its `TileManager` to manage residency.
 */
export interface TileFramePlan<T extends TilePlacement = TilePlacement> {
  plan       : TilePlan<T>;
  loader     : TileLoader<T>;
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
  ): TileCommitResult {
    const pool = this.pool;
    if (!pool) return {};

    const cellCount  = plan.tiles.length;
    if (cellCount >= pool.capacity) {
      throw new Error(
        `Visible tile count ${cellCount} exceeds tile cache budget ${pool.capacity - 1}`,
      );
    }
    const indices    = new Uint32Array(cellCount * 2);
    let displayedLevel: number | undefined;
    for (const tile of plan.tiles) {
      const slot = pool.getSlot(tile.id) ?? 0;
      const fallback = slot === 0 ? this.findCoveringTile(tile, pool) : undefined;
      const fallbackSlot = fallback ? pool.getSlot(fallback.id) ?? 0 : slot;
      const providerLevel = slot === 0 ? fallback?.level : tile.level;
      if (providerLevel !== undefined) {
        displayedLevel = displayedLevel === undefined
          ? providerLevel
          : Math.max(displayedLevel, providerLevel);
      }
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
    return { displayedLevel };
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
      pool.uploadTile(slot, data, tile.region, tile.chunkSize);
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

  private findCoveringTile(tile: T, pool: TilePool): T | undefined {
    let bestTile: T | undefined;
    let bestVolume = Infinity;
    for (const loaded of this.loadedTiles.values()) {
      if (pool.getSlot(loaded.id) === undefined) continue;
      const { start, size } = loaded.region;
      const contains = start.every((value, axis) => (
        value <= tile.region.start[axis] + 1e-9 &&
        value + size[axis] >= tile.region.start[axis] + tile.region.size[axis] - 1e-9
      ));
      if (!contains) continue;
      const volume = size[0] * size[1] * size[2];
      if (volume < bestVolume) {
        bestVolume = volume;
        bestTile = loaded;
      }
    }
    return bestTile;
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
