/**
 * Tile manager — per-view tile residency orchestrator.
 *
 * Held by the per-view `LayerRenderer` inside `ViewPipeline`
 * (primitives/view/pipeline.ts); layers only return plans. Each frame the
 * renderer commits the layer's `TilePlan`, and the manager pushes it onto
 * the GPU (`TilePool`) + load queue (`TileLoadQueue`).
 */

import { TileLoadQueue } from "./queue";
import { TilePool, type TilePoolConfig } from "./pool";
import type { TilePlacement, TilePlan } from "./planner";

/**
 * Per-tile fetch strategy used by `TileManager.loadOne`.
 */
export interface TileLoader<T extends { id: string }> {
  fetch(req: T, signal: AbortSignal): Promise<ArrayBuffer>;
}

export interface TileCommitResult {
  /** Coarsest resident level currently supplying any planned cell. */
  displayedLevel?: number;
  /** Whether every tile in the target plan is resident. */
  complete: boolean;
  /** Whether the spatial index buffer grew and must be rebound before draw. */
  indexBufferChanged: boolean;
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
 * `TileManager<T>` — owns tile residency for one layer within one view:
 * the pool slot map, the load queue, and the shared `pump`/`loadOne` runner.
 * `commit(plan, loader)` is the per-frame entry point.
 */
export class TileManager<T extends TilePlacement> {
  pool?                        : TilePool;
  private readonly queue       : TileLoadQueue<T>;
  private readonly loadedTiles = new Map<string, T>();
  private loader?       : TileLoader<T>;
  private onUpdate?     : () => void;
  private desiredTiles  = new Set<string>();
  private warnedBudget  = false;
  private loadController = new AbortController();

  constructor(maxConcurrent = 4) {
    this.queue = new TileLoadQueue<T>(maxConcurrent);
  }

  /** Synchronous pool construction. Idempotent. */
  init(config: TilePoolConfig): void {
    if (this.pool) return;
    this.pool = new TilePool(config);
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
   * The view wires `setOnUpdate` once at construction; `commit` accepts a
   * fresh `loader` per call because the closures usually capture source /
   * selection / sliceIndex that change between frames.
   */
  commit(
    plan    : TilePlan<T>,
    loader  : TileLoader<T>,
  ): TileCommitResult {
    const pool = this.pool;
    if (!pool) return { complete: false, indexBufferChanged: false };

    const center = plan.viewportOrigin.map((origin, axis) => (
      origin + plan.viewportSize[axis] / 2
    ));

    // If the visible set exceeds the cache (e.g. a volume whose z axis is
    // never downsampled, so every level needs more slabs than fit), degrade
    // gracefully: keep the tiles closest to the viewport center and leave the
    // rest on the placeholder/coarser fallback instead of crashing the frame.
    let tiles = plan.tiles;
    if (tiles.length >= pool.capacity) {
      if (!this.warnedBudget) {
        this.warnedBudget = true;
        console.warn(
          `[TileManager] Visible tile count ${tiles.length} exceeds tile cache budget ${pool.capacity - 1}; ` +
          "clamping to the closest tiles.",
        );
      }
      tiles = [...plan.tiles]
        .sort((a, b) => (
          this.distanceFromCenter(a, center, plan.gridDim) -
          this.distanceFromCenter(b, center, plan.gridDim)
        ))
        .slice(0, Math.max(1, pool.capacity - 1));
    }

    const nextDesired = new Set(tiles.map((tile) => tile.id));
    if (!setsEqual(nextDesired, this.desiredTiles)) {
      this.cancelLoads("Tile plan superseded");
    }

    // Index entries are addressed by gridIdx, which spans the full plan — keep
    // the full width so clamped cells stay on slot 0 (placeholder/fallback).
    const indexBufferChanged = pool.ensureIndexCapacity(plan.tiles.length);
    const indices    = new Uint32Array(plan.tiles.length * 2);
    let displayedLevel: number | undefined;
    for (const tile of tiles) {
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

    const tilesToLoad = tiles
      .filter((tile) => {
        const hasSlot = pool.getSlot(tile.id) !== undefined;
        if (!hasSlot) this.loadedTiles.delete(tile.id);
        return !hasSlot && !this.queue.isLoading(tile.id);
      })
      .sort((a, b) => (
        this.distanceFromCenter(a, center, plan.gridDim) -
        this.distanceFromCenter(b, center, plan.gridDim)
      ));

    this.loader = loader;
    this.desiredTiles = nextDesired;
    this.queue.setDesired(this.desiredTiles, tilesToLoad);
    this.pump();
    return {
      displayedLevel,
      complete: plan.tiles.every((tile) => pool.getSlot(tile.id) !== undefined),
      indexBufferChanged,
    };
  }

  /** Schedule any pending tile loads up to the queue's concurrency limit. */
  pump(): void {
    const pool   = this.pool;
    const loader = this.loader;
    if (!pool || !loader) return;
    this.queue.pump(
      (tile) => pool.getSlot(tile.id) === undefined,
      (tile, generation) => {
        void this.loadOne(tile, generation, pool, loader, this.loadController.signal);
      },
    );
  }

  private async loadOne(
    tile: T,
    generation: number,
    pool: TilePool,
    loader: TileLoader<T>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const data = await loader.fetch(tile, signal);
      if (!this.queue.shouldAccept(tile.id, generation)) return;
      if (pool.getSlot(tile.id) !== undefined) return;
      const slot = pool.allocateSlot(tile.id);
      pool.uploadTile(slot, data, tile.region, tile.chunkSize);
      this.loadedTiles.set(tile.id, tile);
      this.onUpdate?.();
    } catch (e) {
      const currentGeneration = generation === this.queue.currentGeneration;
      if (currentGeneration && !(e instanceof DOMException && e.name === "AbortError")) {
        console.warn(`[TileManager] Failed to load tile ${tile.id}:`, e);
      }
      if (currentGeneration) this.loadedTiles.delete(tile.id);
    } finally {
      this.queue.finish(tile.id, generation);
      this.pump();
    }
  }

  /** Drop all in-flight loads, cached placements, desired IDs, and pool residency. */
  reset(): void {
    this.cancelLoads("Tile residency reset");
    this.loadedTiles.clear();
    this.desiredTiles.clear();
    this.pool?.reset();
  }

  private cancelLoads(reason: string): void {
    this.loadController.abort(new DOMException(reason, "AbortError"));
    this.loadController = new AbortController();
    this.queue.reset();
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

function setsEqual(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  if (first.size !== second.size) return false;
  for (const value of first) {
    if (!second.has(value)) return false;
  }
  return true;
}
