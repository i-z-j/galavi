/**
 * TileLoadQueue / TileManager tests.
 *
 * The GPU boundary is faked: `TileManager.pool` stays public (custom views
 * need its texture/buffers), so tests install a duck-typed pool (slot map +
 * upload spy + no-op queue writes) instead of a real `TilePool`/`GPUDevice`.
 * Everything else is asserted through public behavior — `commit`,
 * `hasVisibleTile`, the pool's observable state, and `onUpdate` callbacks —
 * never by poking the manager's private queue/loadedTiles internals. Loaders
 * are deferred promises so the async load lifecycle stays fully deterministic.
 */
import { describe, expect, test, vi } from "vitest";
import {
  TileLoadQueue,
  TileManager,
  type TileLoader,
  type TilePlacement,
  type TilePlan,
  type TilePool,
} from "../../../src/viewer/tile";

// ============================================================================
// HELPERS
// ============================================================================

interface TestTile extends TilePlacement { id: string }

function makeTile(id: string, gridIdx: number): TestTile {
  return {
    id,
    gridIdx,
    voxelPos  : [0, 0, 0],
    level     : 0,
    chunkSize : [1, 1, 1] as [number, number, number],
    region    : { start: [0, 0, 0] as [number, number, number], size: [1, 1, 1] as [number, number, number] },
  };
}

function makePlan(tiles: TestTile[]): TilePlan<TestTile> {
  return {
    level          : 0,
    viewportOrigin : [0, 0, 0],
    viewportSize   : [1, 1, 1],
    gridOrigin     : [0, 0, 0],
    gridShape      : [1, 1, 1],
    tileNormSize   : [1, 1, 1],
    tiles,
    gridDim        : 3,
  };
}

/** Minimal duck-type of TilePool — only the surface TileManager touches. */
class FakePool {
  readonly capacity     = 16;
  indexBuffer           = {};
  private indexCapacity = this.capacity;
  readonly device       = {
    queue: {
      writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBufferView) => {
        if (data.byteLength > this.indexCapacity * 2 * Uint32Array.BYTES_PER_ELEMENT) {
          throw new RangeError("index buffer write exceeds resident tile capacity");
        }
      },
    },
  };

  ensureIndexCapacity(entryCount: number): boolean {
    if (entryCount <= this.indexCapacity) return false;
    this.indexCapacity = entryCount;
    this.indexBuffer = {};
    return true;
  }
  readonly uploadTile   = vi.fn();
  private slots         = new Map<string, number>();

  getSlot(id: string): number | undefined { return this.slots.get(id); }
  allocateSlot(id: string): number {
    const slot = this.slots.size + 1;
    this.slots.set(id, slot);
    return slot;
  }
  reset(): void { this.slots.clear(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let the `loadOne` continuation after `await loader.fetch(...)` run. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeManager(maxConcurrent: number) {
  const manager = new TileManager<TestTile>(maxConcurrent);
  const pool    = new FakePool();
  manager.pool  = pool as unknown as TilePool;
  return { manager, pool };
}

/** Loader whose fetches are individually resolvable deferreds, keyed by tile id. */
function deferredLoader() {
  const fetches = new Map<string, ReturnType<typeof deferred<ArrayBuffer>>>();
  const loader: TileLoader<TestTile> = {
    fetch: (tile) => {
      const d = deferred<ArrayBuffer>();
      fetches.set(tile.id, d);
      return d.promise;
    },
  };
  return { loader, fetches };
}

// ============================================================================
// TILE LOAD QUEUE
// ============================================================================

describe("TileLoadQueue", () => {
  test("pump starts loads up to the concurrency limit and marks them loading", () => {
    const queue   = new TileLoadQueue<TestTile>(2);
    const tiles   = [makeTile("a", 0), makeTile("b", 1), makeTile("c", 2)];
    const started: string[] = [];
    queue.setDesired(["a", "b", "c"], tiles);

    queue.pump(() => true, (tile) => { started.push(tile.id); });

    expect(started).toEqual(["a", "b"]);
    expect(queue.isLoading("a")).toBe(true);
    expect(queue.isLoading("c")).toBe(false);
  });

  test("finish() frees a slot so the next pending tile can start", () => {
    const queue   = new TileLoadQueue<TestTile>(1);
    const tiles   = [makeTile("a", 0), makeTile("b", 1)];
    const started: string[] = [];
    queue.setDesired(["a", "b"], tiles);

    let generation = 0;
    queue.pump(() => true, (tile, currentGeneration) => {
      generation = currentGeneration;
      started.push(tile.id);
    });
    queue.finish("a", generation);
    queue.pump(() => true, (tile) => { started.push(tile.id); });

    expect(started).toEqual(["a", "b"]);
  });

  test("stale completion does not clear a replacement load with the same id", () => {
    const queue = new TileLoadQueue<TestTile>(2);
    const generations: number[] = [];
    queue.setDesired(["a"], [makeTile("a", 0)]);
    queue.pump(() => true, (_tile, generation) => generations.push(generation));
    const staleGeneration = generations[0];

    queue.reset();
    queue.setDesired(["a"], [makeTile("a", 0)]);
    queue.pump(() => true, (_tile, generation) => generations.push(generation));
    expect(queue.isLoading("a")).toBe(true);

    queue.finish("a", staleGeneration);
    expect(queue.isLoading("a")).toBe(true);
    queue.finish("a", generations[1]);
    expect(queue.isLoading("a")).toBe(false);
  });

  test("pump skips tiles that are no longer desired", () => {
    const queue   = new TileLoadQueue<TestTile>(4);
    const started: string[] = [];
    queue.setDesired(["b"], [makeTile("a", 0), makeTile("b", 1)]);

    queue.pump(() => true, (tile) => { started.push(tile.id); });

    expect(started).toEqual(["b"]);
  });

  test("reset() invalidates the generation so stale loads are rejected", () => {
    const queue = new TileLoadQueue<TestTile>(4);
    queue.setDesired(["a"], [makeTile("a", 0)]);
    const generation = queue.currentGeneration;
    expect(queue.shouldAccept("a", generation)).toBe(true);

    queue.reset();

    expect(queue.currentGeneration).toBe(generation + 1);
    expect(queue.shouldAccept("a", generation)).toBe(false);
    expect(queue.shouldAccept("a", queue.currentGeneration)).toBe(false); // not desired anymore
  });
});

// ============================================================================
// TILE MANAGER
// ============================================================================

describe("TileManager", () => {
  test("commit loads missing tiles, uploads them, and reports the displayed level", async () => {
    const { manager, pool } = makeManager(4);
    const onUpdate = vi.fn();
    manager.setOnUpdate(onUpdate);

    const { loader, fetches } = deferredLoader();
    const tiles = [makeTile("a", 0), makeTile("b", 1)];
    const first = manager.commit(makePlan(tiles), loader);
    expect(first.displayedLevel).toBeUndefined(); // nothing resident yet
    expect(first.complete).toBe(false);
    expect(fetches.size).toBe(2);

    fetches.get("a")!.resolve(new ArrayBuffer(8));
    fetches.get("b")!.resolve(new ArrayBuffer(8));
    await flushMicrotasks();

    expect(pool.uploadTile).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(manager.hasVisibleTile()).toBe(true);

    // Second commit: tiles are resident — no re-fetch, level reported.
    const second = manager.commit(makePlan(tiles), loader);
    expect(second.displayedLevel).toBe(0);
    expect(second.complete).toBe(true);
    expect(fetches.size).toBe(2);
  });

  test("a load that resolves after reset() is dropped as stale", async () => {
    const { manager, pool } = makeManager(4);
    const onUpdate = vi.fn();
    manager.setOnUpdate(onUpdate);

    const d = deferred<ArrayBuffer>();
    let loadSignal: AbortSignal | undefined;
    const loader: TileLoader<TestTile> = {
      fetch: (_tile, signal) => {
        loadSignal = signal;
        return d.promise;
      },
    };
    manager.commit(makePlan([makeTile("a", 0)]), loader);

    manager.reset();
    expect(loadSignal?.aborted).toBe(true);
    d.resolve(new ArrayBuffer(8));
    await flushMicrotasks();

    expect(pool.uploadTile).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(manager.hasVisibleTile()).toBe(false);

    // Residency was dropped: re-committing the same plan fetches again.
    const { loader: reLoader, fetches } = deferredLoader();
    expect(manager.commit(makePlan([makeTile("a", 0)]), reLoader).complete).toBe(false);
    expect(fetches.has("a")).toBe(true);
  });

  test("replanning aborts superseded loads but preserves resident fallback tiles", async () => {
    const { manager, pool } = makeManager(2);

    // Seed real residency: commit a coarse tile and let its load complete.
    const { loader: coarseLoader, fetches } = deferredLoader();
    manager.commit(makePlan([makeTile("coarse", 0)]), coarseLoader);
    fetches.get("coarse")!.resolve(new ArrayBuffer(8));
    await flushMicrotasks();
    expect(pool.getSlot("coarse")).toBeDefined();

    // Switch to a fine plan whose load stays in flight.
    const first = deferred<ArrayBuffer>();
    let firstSignal: AbortSignal | undefined;
    const firstLoader: TileLoader<TestTile> = {
      fetch: (_tile, signal) => {
        firstSignal = signal;
        return first.promise;
      },
    };
    manager.commit(makePlan([makeTile("old", 0)]), firstLoader);

    // Replan again: the superseded in-flight load is aborted, the resident
    // coarse tile survives and covers the new tile as fallback.
    const nextLoader: TileLoader<TestTile> = {
      fetch: () => new Promise(() => {}),
    };
    const result = manager.commit(makePlan([makeTile("new", 0)]), nextLoader);

    expect(firstSignal?.aborted).toBe(true);
    expect(pool.getSlot("coarse")).toBeDefined();
    expect(result.complete).toBe(false);
    expect(result.displayedLevel).toBe(0); // supplied by the coarse fallback

    // The aborted load resolving late must not upload or disturb residency.
    first.resolve(new ArrayBuffer(8));
    await flushMicrotasks();
    expect(pool.uploadTile).toHaveBeenCalledTimes(1); // only the coarse tile
    expect(pool.getSlot("coarse")).toBeDefined();
  });

  test("a late stale rejection cannot delete a loaded replacement with the same id", async () => {
    const { manager } = makeManager(2);
    const stale = deferred<ArrayBuffer>();
    manager.commit(makePlan([makeTile("a", 0)]), { fetch: () => stale.promise });

    const replacement = deferred<ArrayBuffer>();
    manager.commit(makePlan([makeTile("a", 0), makeTile("b", 1)]), {
      fetch: (tile) => tile.id === "a" ? replacement.promise : new Promise(() => {}),
    });
    replacement.resolve(new ArrayBuffer(8));
    await flushMicrotasks();
    expect(manager.commit(makePlan([makeTile("a", 0)]), {
      fetch: () => new Promise(() => {}),
    }).complete).toBe(true);

    stale.reject(new Error("late stale failure"));
    await flushMicrotasks();

    // "a" must still count as loaded residency: a tile strictly inside its
    // region finds it as covering fallback, which only loaded tiles provide.
    const inner = makeTile("inner", 0);
    inner.region = {
      start : [0.25, 0.25, 0.25] as [number, number, number],
      size  : [0.5, 0.5, 0.5] as [number, number, number],
    };
    const probe = manager.commit(makePlan([inner]), {
      fetch: () => new Promise(() => {}),
    });
    expect(probe.displayedLevel).toBe(0);
  });

  test("reports whether every target tile is resident", async () => {
    const { manager } = makeManager(2);
    const data = deferred<ArrayBuffer>();
    const loader: TileLoader<TestTile> = { fetch: () => data.promise };
    const plan = makePlan([makeTile("a", 0)]);

    expect(manager.commit(plan, loader).complete).toBe(false);
    data.resolve(new ArrayBuffer(8));
    await flushMicrotasks();
    expect(manager.commit(plan, loader).complete).toBe(true);
  });

  test("a failed load does not upload and is retried on the next commit", async () => {
    const { manager, pool } = makeManager(4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const d = deferred<ArrayBuffer>();
    const loader: TileLoader<TestTile> = { fetch: () => d.promise };
    manager.commit(makePlan([makeTile("a", 0)]), loader);

    d.reject(new Error("network down"));
    await flushMicrotasks();

    expect(pool.uploadTile).not.toHaveBeenCalled();
    expect(manager.hasVisibleTile()).toBe(false);

    // The failure left no residency: re-committing starts a fresh fetch.
    const { loader: retryLoader, fetches } = deferredLoader();
    manager.commit(makePlan([makeTile("a", 0)]), retryLoader);
    expect(fetches.has("a")).toBe(true);
    warn.mockRestore();
  });

  test("in-flight loads never exceed the concurrency limit", async () => {
    const { manager } = makeManager(1);
    const fetches: ReturnType<typeof deferred<ArrayBuffer>>[] = [];
    const loader: TileLoader<TestTile> = {
      fetch: () => {
        const d = deferred<ArrayBuffer>();
        fetches.push(d);
        return d.promise;
      },
    };

    manager.commit(makePlan([makeTile("a", 0), makeTile("b", 1), makeTile("c", 2)]), loader);
    expect(fetches.length).toBe(1);

    fetches[0]!.resolve(new ArrayBuffer(8));
    await flushMicrotasks();
    expect(fetches.length).toBe(2);

    fetches[1]!.resolve(new ArrayBuffer(8));
    await flushMicrotasks();
    expect(fetches.length).toBe(3);
  });

  test("an over-budget plan is clamped to the closest tiles instead of throwing", () => {
    const { manager } = makeManager(4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetches: string[] = [];
    const loader: TileLoader<TestTile> = {
      fetch: (tile) => {
        fetches.push(tile.id);
        return new Promise(() => {});
      },
    };

    // FakePool capacity is 16 — a 20-tile plan must not throw.
    const tiles = Array.from({ length: 20 }, (_, i) => {
      const tile = makeTile(`t${i}`, i);
      // Spread tiles along x so the center-closest ones are the middle ids.
      tile.region = { start: [i, 0, 0] as [number, number, number], size: [1, 1, 1] as [number, number, number] };
      return tile;
    });
    expect(manager.commit(makePlan(tiles), loader).indexBufferChanged).toBe(true);
    expect(manager.commit(makePlan(tiles), loader).indexBufferChanged).toBe(false);
    expect(fetches.length).toBeLessThanOrEqual(15);
    warn.mockRestore();
  });
});
