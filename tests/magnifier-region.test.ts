import { describe, expect, test } from "vitest";
import type { ImagePyramid } from "../src/types";
import { VolumeLayer } from "../src/layer";
import { computeMagnifierVoxelRegion } from "../src/utils/magnifier-region";

const identityModel = new Float32Array([
  1000, 0, 0, 0,
  0, 1000, 0, 0,
  0, 0, 1000, 0,
  0, 0, 0, 1,
]);

describe("computeMagnifierVoxelRegion", () => {
  test("derives physical size from an exact level-0 voxel extent", () => {
    const pyramid: ImagePyramid = {
      levels: [{ path: "0", shape: [200_000, 200_000, 200_000], chunkSize: [32, 32, 32], scale: [0.005, 0.005, 0.005] }],
    };

    const region = computeMagnifierVoxelRegion({
      pyramid,
      model: identityModel,
      position: [500, 500, 500],
      voxelExtent: 32,
    });

    expect(region.finestShape).toEqual([32, 32, 32]);
    expect(region.worldSize).toEqual([0.16, 0.16, 0.16]);
    expect(region.normalizedBounds).toEqual({
      min: [0.49992, 0.49992, 0.49992],
      max: [0.50008, 0.50008, 0.50008],
    });
  });

  test("keeps 32 voxels on coarse data and slides at edges", () => {
    const pyramid: ImagePyramid = {
      levels: [{ path: "0", shape: [100, 100, 100], chunkSize: [16, 16, 16], scale: [5, 5, 5] }],
    };
    const model = new Float32Array([
      500, 0, 0, 0,
      0, 500, 0, 0,
      0, 0, 500, 0,
      0, 0, 0, 1,
    ]);

    const region = computeMagnifierVoxelRegion({
      pyramid,
      model,
      position: [1, 499, 250],
      voxelExtent: 32,
    });

    expect(region.finestShape).toEqual([32, 32, 32]);
    expect(region.finestOrigin).toEqual([0, 68, 34]);
    expect(region.worldSize).toEqual([160, 160, 160]);
    expect(region.worldCenter[0]).toBeCloseTo(80);
    expect(region.worldCenter[1]).toBeCloseTo(420);
    expect(region.worldCenter[2]).toBeCloseTo(250);
  });

  test("supports a configurable cubic voxel extent", () => {
    const pyramid: ImagePyramid = {
      levels: [{ path: "0", shape: [100, 100, 100], chunkSize: [16, 16, 16], scale: [1, 1, 1] }],
    };
    const region = computeMagnifierVoxelRegion({
      pyramid,
      model: new Float32Array([
        100, 0, 0, 0,
        0, 100, 0, 0,
        0, 0, 100, 0,
        0, 0, 0, 1,
      ]),
      position: [50, 50, 50],
      voxelExtent: 16,
    });

    expect(region.finestShape).toEqual([16, 16, 16]);
    expect(region.worldSize).toEqual([16, 16, 16]);
  });
});

describe("tiled magnifier region", () => {
  const pyramid: ImagePyramid = {
    levels: [
      { path: "0", shape: [128, 128, 128], chunkSize: [16, 16, 16], scale: [1, 1, 1] },
      { path: "1", shape: [64, 64, 64], chunkSize: [16, 16, 16], scale: [2, 2, 2] },
      { path: "2", shape: [32, 32, 32], chunkSize: [16, 16, 16], scale: [4, 4, 4] },
    ],
  };

  test("uses the coarsest initial frame then forces finest whole chunks", () => {
    const layer = VolumeLayer.fromConfig("v", {
      id: "v",
      type: "volume",
      data: { pyramid, fetch: () => Promise.resolve(new ArrayBuffer(0)) },
      options: {
        region: { min: [0.2, 0.2, 0.2], max: [0.45, 0.45, 0.45] },
        finestLevel: true,
      },
    });
    const viewport = {
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      worldUnitsPerPixel: 100,
      tileBudget: 512,
    };

    const initial = layer.planTiles({ ...viewport, forcedLevel: 2 });
    const refined = layer.planTiles(viewport);

    expect(initial?.plan.level).toBe(2);
    expect(refined?.plan.level).toBe(0);
    expect(refined?.plan.viewportOrigin).toEqual([0.2, 0.2, 0.2]);
    expect(refined?.plan.viewportSize).toEqual([0.25, 0.25, 0.25]);
    expect(refined?.plan.tiles.every((tile) => (
      tile.voxelPos.every((value) => value % 16 === 0)
    ))).toBe(true);
  });

  test("crops the volume world bounds to the effective region", () => {
    const layer = VolumeLayer.fromConfig("v", {
      id: "v",
      type: "volume",
      data: { pyramid, fetch: () => Promise.resolve(new ArrayBuffer(0)) },
      options: {
        region: { min: [0.2, 0.3, 0.4], max: [0.4, 0.6, 0.8] },
      },
    });
    layer.applyConfig({
      id: "v",
      type: "volume",
      data: { pyramid, fetch: () => Promise.resolve(new ArrayBuffer(0)) },
      options: {
        region: { min: [0.2, 0.3, 0.4], max: [0.4, 0.6, 0.8] },
      },
    }, {
      spatial: { size: [100, 200, 300], origin: [10, 20, 30] },
    });

    expect(layer.getWorldAABB()).toEqual({
      min: [30, 80, 150],
      max: [50, 140, 270],
    });
  });
});
