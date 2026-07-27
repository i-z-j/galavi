/**
 * TileLoadQueue / TileManager tests.
 *
 * The GPU boundary is faked: `TileManager.pool` is a public field, so tests
 * install a duck-typed pool (slot map + upload spy + no-op queue writes)
 * instead of a real `TilePool`/`GPUDevice`. Loaders are deferred promises so
 * the async load lifecycle stays fully deterministic.
 */
import { describe, expect, test, vi } from "vitest";
import {
  TileLoadQueue,
  TileManager,
  type TileLoader,
  type TilePlacement,
  type TilePlan,
  type TilePool,
} from "../src/utils/tile";

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
  readonly indexBuffer  = {};
  readonly device       = { queue: { writeBuffer: () => {} } };
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

    queue.pump(() => true, (tile) => { started.push(tile.id); });
    queue.finish("a");
    queue.pump(() => true, (tile) => { started.push(tile.id); });

    expect(started).toEqual(["a", "b"]);
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

    const fetches = new Map<string, ReturnType<typeof deferred<ArrayBuffer>>>();
    const loader: TileLoader<TestTile> = {
      fetch: (tile) => {
        const d = deferred<ArrayBuffer>();
        fetches.set(tile.id, d);
        return d.promise;
      },
    };

    const tiles = [makeTile("a", 0), makeTile("b", 1)];
    const first = manager.commit(makePlan(tiles), loader);
    expect(first.displayedLevel).toBeUndefined(); // nothing resident yet
    expect(fetches.size).toBe(2);

    fetches.get("a")!.resolve(new ArrayBuffer(8));
    fetches.get("b")!.resolve(new ArrayBuffer(8));
    await flushMicrotasks();

    expect(pool.uploadTile).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(manager.loadedTiles.size).toBe(2);
    expect(manager.hasVisibleTile()).toBe(true);

    // Second commit: tiles are resident — no re-fetch, level reported.
    const second = manager.commit(makePlan(tiles), loader);
    expect(second.displayedLevel).toBe(0);
    expect(fetches.size).toBe(2);
  });

  test("a load that resolves after reset() is dropped as stale", async () => {
    const { manager, pool } = makeManager(4);
    const onUpdate = vi.fn();
    manager.setOnUpdate(onUpdate);

    const d = deferred<ArrayBuffer>();
    const loader: TileLoader<TestTile> = { fetch: () => d.promise };
    manager.commit(makePlan([makeTile("a", 0)]), loader);

    manager.reset();
    d.resolve(new ArrayBuffer(8));
    await flushMicrotasks();

    expect(pool.uploadTile).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(manager.loadedTiles.size).toBe(0);
  });

  test("a failed load is removed from loadedTiles and does not upload", async () => {
    const { manager, pool } = makeManager(4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const d = deferred<ArrayBuffer>();
    const loader: TileLoader<TestTile> = { fetch: () => d.promise };
    manager.commit(makePlan([makeTile("a", 0)]), loader);

    d.reject(new Error("network down"));
    await flushMicrotasks();

    expect(pool.uploadTile).not.toHaveBeenCalled();
    expect(manager.loadedTiles.size).toBe(0);
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
});
