/**
 * Automatic volume tile-budget policy tests.
 *
 * Volume layers keep every z slab of the chosen level resident, so z-chunk=1
 * pyramids with hundreds of slabs per level (IDR0066 brain: 1937 slabs of
 * 256×256 chunks; idr0048A astrocytes: 1402 slabs at every level) are
 * unrenderable as-is. Without an explicit `maxPoolSize` override, VolumeLayer
 * must automatically derive a bounded z-strided preview (`planVolumePreview`)
 * and size the tile pool for it. Well-behaved pyramids and explicit overrides
 * must render exactly as before. Slice layers never get the preview policy.
 *
 * Data-side only: no network, no WebGPU device.
 */
import { describe, expect, test, vi } from "vitest";
import type { Data, ImagePyramid } from "../../src/state/schema";
import { SliceLayer, VolumeLayer } from "../../src/primitives/layer";
import {
  planVolumePreview,
  VOLUME_PREVIEW_MAX_SLABS,
  VOLUME_PREVIEW_MAX_TILES,
  VOLUME_PREVIEW_MAX_CHUNK_TEXELS,
  VOLUME_PREVIEW_POOL_HEADROOM,
} from "../../src/viewer/tile";

// === Synthetic fixtures (mirror the real stores' pathological shapes) ===

const level = (
  path: string,
  shape: [number, number, number],
  chunkSize: [number, number, number],
  scale: [number, number, number],
) => ({ path, shape, chunkSize, scale });

/** IDR0066-like: 1937 z slabs of 256×256 chunks; xy downsampling only. */
const brainPyramid: ImagePyramid = {
  levels: [
    level("0", [4096, 4096, 1937], [256, 256, 1], [1, 1, 2]),
    level("1", [2048, 2048, 1937], [256, 256, 1], [2, 2, 2]),
    level("2", [1024, 1024, 1937], [256, 256, 1], [4, 4, 2]),
    level("3", [512, 512, 1937], [256, 256, 1], [8, 8, 2]),
    level("4", [256, 256, 1937], [256, 256, 1], [16, 16, 2]),
  ],
};

/** idr0048A-like: 1402 z slabs at every level. */
const astrocytesPyramid: ImagePyramid = {
  levels: [
    level("0", [512, 512, 1402], [256, 256, 1], [1, 1, 1]),
    level("1", [256, 256, 1402], [256, 256, 1], [2, 2, 1]),
  ],
};

/** Well-behaved store: chunky z, few slabs per level. */
const chameleonPyramid: ImagePyramid = {
  levels: [
    level("0", [1024, 1024, 256], [256, 256, 64], [1, 1, 1]),
    level("1", [512, 512, 128], [256, 256, 64], [2, 2, 2]),
    level("2", [256, 256, 64], [256, 256, 64], [4, 4, 4]),
  ],
};

/** z-chunk = 1 but few slabs — well within the slab budget. */
const shallowPyramid: ImagePyramid = {
  levels: [level("0", [512, 512, 100], [256, 256, 1], [1, 1, 1])],
};

const noopFetch: NonNullable<Data["fetch"]> = () =>
  Promise.resolve(new ArrayBuffer(0));

function fullViewport(forcedLevel?: number) {
  return {
    bounds             : { min: [0, 0, 0], max: [1, 1, 1] },
    worldUnitsPerPixel : 1,
    tileBudget         : 1_000_000,
    ...(forcedLevel !== undefined ? { forcedLevel } : {}),
  };
}

describe("planVolumePreview", () => {
  test("returns null for well-behaved pyramids (chunky z or few slabs)", () => {
    expect(planVolumePreview(chameleonPyramid)).toBeNull();
    expect(planVolumePreview(shallowPyramid)).toBeNull();
    expect(planVolumePreview({ levels: [] })).toBeNull();
  });

  test("bounds the brain fixture to the slab/tile/texel budgets", () => {
    const plan = planVolumePreview(brainPyramid);
    expect(plan).not.toBeNull();

    // stride = ceil(1937 / 384) = 6 → 323 virtual slabs per kept level.
    for (const l of plan!.pyramid.levels) {
      expect(l.chunkSize[2]).toBe(1);
      expect(l.shape[2]).toBe(323);
      expect(l.shape[2]).toBeLessThanOrEqual(VOLUME_PREVIEW_MAX_SLABS);
      const tiles =
        Math.ceil(l.shape[0] / l.chunkSize[0]) *
        Math.ceil(l.shape[1] / l.chunkSize[1]) *
        l.shape[2];
      expect(tiles).toBeLessThanOrEqual(VOLUME_PREVIEW_MAX_TILES);
      const texels = l.chunkSize[0] * l.chunkSize[1] * l.chunkSize[2];
      expect(texels).toBeLessThanOrEqual(VOLUME_PREVIEW_MAX_CHUNK_TEXELS);
    }

    // Fine levels whose tile count blows the budget are excluded; the
    // coarsest level is always kept as a fallback. Here: real levels 3 and 4.
    expect(plan!.pyramid.levels.map((l) => l.path)).toEqual(["3", "4"]);
    expect(plan!.maxTiles).toBe(2 * 2 * 323); // 1292 ≤ 1296
  });

  test("bounds the astrocytes fixture (1402 slabs at every level)", () => {
    const plan = planVolumePreview(astrocytesPyramid);
    expect(plan).not.toBeNull();
    // stride = ceil(1402 / 384) = 4 → 351 virtual slabs. The fine level's
    // 2×2×351 = 1404 tiles exceed the budget, so only the coarsest survives.
    expect(plan!.pyramid.levels.map((l) => l.path)).toEqual(["1"]);
    expect(plan!.pyramid.levels[0].shape[2]).toBe(351);
    expect(plan!.maxTiles).toBe(351);
  });

  test("wrapFetch maps virtual levels and strided slabs back to real chunks", () => {
    const plan = planVolumePreview(brainPyramid)!;
    const spy = vi.fn(noopFetch);
    const fetch = plan.wrapFetch(spy);

    // Virtual level 0 ↔ real level 3 (chunk z = 1 → realChunkZ = 1);
    // virtual slab 5 ↔ real z = 5 × stride(6) × 1 = 30.
    void fetch({ level: 0, position: [256, 512, 5] });
    expect(spy).toHaveBeenCalledWith({
      level    : 3,
      position : [256, 512, 30],
    });

    // Virtual level 1 ↔ real level 4; selection/signal pass through.
    const signal = new AbortController().signal;
    void fetch({ level: 1, position: [0, 0, 322], selection: { c: 2 }, signal });
    expect(spy).toHaveBeenLastCalledWith({
      level     : 4,
      position  : [0, 0, 1932],
      selection : { c: 2 },
      signal,
    });

    // Undefined request passes through (custom-fetch contract).
    void fetch(undefined);
    expect(spy).toHaveBeenLastCalledWith(undefined);
  });
});

describe("VolumeLayer automatic preview policy", () => {
  test("pathological pyramid without maxPoolSize: bounded preview + sized pool", () => {
    const layer = new VolumeLayer("v", {
      source: { pyramid: brainPyramid, fetch: noopFetch },
    });

    const spec = layer.getTileSpec();
    expect(spec).not.toBeNull();
    // Pool sized to the largest preview level's tile set + headroom.
    expect(spec!.maxPoolSize).toBe(1292 + VOLUME_PREVIEW_POOL_HEADROOM);
    // Slot depth collapses to one virtual slab.
    expect(spec!.slotSize).toEqual([256, 256, 1]);

    // Planning the finest kept (virtual) level stays within the tile budget.
    const frame = layer.planTiles(fullViewport(0));
    expect(frame).not.toBeNull();
    expect(frame!.plan.tiles).toHaveLength(1292);
    expect(Math.max(...frame!.plan.tiles.map((t) => t.voxelPos[2]))).toBe(322);
  });

  test("planned fetches hit the strided real pyramid", async () => {
    const spy = vi.fn(noopFetch);
    const layer = new VolumeLayer("v", {
      source: { pyramid: brainPyramid, fetch: spy },
    });
    const frame = layer.planTiles(fullViewport(0))!;

    const tile = frame.plan.tiles[4]; // grid [2,2,323], x-fastest → z slab 1
    expect(tile.voxelPos).toEqual([0, 0, 1]);
    await frame.loader.fetch(tile, new AbortController().signal);
    expect(spy).toHaveBeenCalledWith({
      level     : 3,
      position  : [0, 0, 6], // slab 1 × stride 6
      selection : {},
      signal    : expect.any(AbortSignal),
    });
  });

  test("explicit maxPoolSize wins: no wrap, no pool resizing", () => {
    const spy = vi.fn(noopFetch);
    const layer = new VolumeLayer("v", {
      maxPoolSize : 64,
      source      : { pyramid: brainPyramid, fetch: spy },
    });

    const spec = layer.getTileSpec();
    expect(spec!.maxPoolSize).toBe(64);
    expect(spec!.slotSize).toEqual([256, 256, 1]); // raw chunks

    // The coarsest real level plans every slab — no striding.
    const frame = layer.planTiles(fullViewport(4))!;
    expect(frame.plan.tiles).toHaveLength(1937);
    const tile = frame.plan.tiles[5];
    expect(tile.voxelPos).toEqual([0, 0, 5]);
    void frame.loader.fetch(tile, new AbortController().signal);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      level    : 4,
      position : [0, 0, 5], // unstrided
    }));
  });

  test("well-behaved pyramids are untouched (chameleon contract)", () => {
    const layer = new VolumeLayer("v", {
      source: { pyramid: chameleonPyramid, fetch: noopFetch },
    });

    const spec = layer.getTileSpec();
    expect(spec!.maxPoolSize).toBeUndefined();
    expect(spec!.slotSize).toEqual([256, 256, 64]);
    expect(spec!.initialLevel).toBe(2);

    const frame = layer.planTiles(fullViewport(2))!;
    // 1×1×1 chunks of 256×256×64 at the coarsest level — full grid, no wrap.
    expect(frame.plan.tiles).toHaveLength(1);
    expect(frame.plan.tiles[0].chunkSize).toEqual([256, 256, 64]);
  });

  test("shallow z-chunk=1 pyramid is not pathological and stays untouched", () => {
    const layer = new VolumeLayer("v", {
      source: { pyramid: shallowPyramid, fetch: noopFetch },
    });
    expect(layer.getTileSpec()!.maxPoolSize).toBeUndefined();
    expect(layer.planTiles(fullViewport(0))!.plan.tiles).toHaveLength(2 * 2 * 100);
  });

  test("urlTemplate-only sources cannot be strided and pass through untouched", () => {
    const layer = new VolumeLayer("v", {
      source: {
        pyramid     : brainPyramid,
        url         : "https://example.test/brain",
        urlTemplate : "{url}:{level}:{z},{y},{x}",
      },
    });
    const spec = layer.getTileSpec();
    expect(spec!.maxPoolSize).toBeUndefined();
    const frame = layer.planTiles(fullViewport(4))!;
    expect(frame.plan.tiles).toHaveLength(1937); // no wrap without fetch
  });

  test("slice layers never get the preview policy", () => {
    const layer = new SliceLayer("s", {
      source: { pyramid: brainPyramid, fetch: noopFetch },
    });
    const spec = layer.getTileSpec();
    expect(spec!.maxPoolSize).toBeUndefined();
    // Slice planes still see the full-resolution xy shape of level 0.
    expect(layer.dataSize).toEqual([4096, 4096, 1937]);
  });

  // The 3D magnifier wraps its layers with a level-0 voxel crop (`region` +
  // `finestLevel`): the crop itself bounds residency, so the strided preview
  // must NOT apply — the magnifier exists to show full-resolution data.
  test("region-bounded layers (3D magnifier crop) skip the strided preview", async () => {
    const spy = vi.fn(noopFetch);
    const layer = new VolumeLayer("mag", {
      source      : { pyramid: brainPyramid, fetch: spy },
      region      : { min: [0, 0, 0], max: [0.1, 0.1, 0.1] },
      finestLevel : true,
    });

    const spec = layer.getTileSpec();
    // No preview pool sizing — the policy did not engage.
    expect(spec!.maxPoolSize).toBeUndefined();

    // Level 0 of the REAL pyramid (finestLevel), cropped to the region:
    // 2×2 xy chunks (410 > 256) × 194 real z slabs — no striding.
    const frame = layer.planTiles(fullViewport(0))!;
    expect(frame.plan.tiles).toHaveLength(2 * 2 * 194);
    expect(Math.max(...frame.plan.tiles.map((t) => t.voxelPos[2]))).toBe(193);

    const tile = frame.plan.tiles[4]; // grid [2,2,194], x-fastest → z slab 1
    expect(tile.voxelPos).toEqual([0, 0, 1]);
    await frame.loader.fetch(tile, new AbortController().signal);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      level    : 0,
      position : [0, 0, 1], // unstrided real slab
    }));
  });

  test("gaining a region at runtime re-evaluates the policy (memo invalidated)", () => {
    const layer = new VolumeLayer("mag", {
      source: { pyramid: brainPyramid, fetch: noopFetch },
    });
    // Without a region the preview policy engages.
    expect(layer.getTileSpec()!.maxPoolSize).toBe(1292 + VOLUME_PREVIEW_POOL_HEADROOM);

    // Applying a region-bounded config drops the memoized wrapped source.
    layer.applyConfig({
      id      : "mag",
      type    : "volume",
      data    : { pyramid: brainPyramid, fetch: noopFetch },
      options : { region: { min: [0, 0, 0], max: [0.1, 0.1, 0.1] }, finestLevel: true },
    }, undefined);
    expect(layer.getTileSpec()!.maxPoolSize).toBeUndefined();
    const frame = layer.planTiles(fullViewport(0))!;
    expect(Math.max(...frame.plan.tiles.map((t) => t.voxelPos[2]))).toBe(193);
  });
});
