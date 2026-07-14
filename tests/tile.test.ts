import { describe, expect, test } from "bun:test";
import type { ImagePyramid, Vec3 } from "../src/types";
import {
  pickPyramidLevel,
  planTiles,
  type TilePlacement,
} from "../src/utils/tile";

const pyramid: ImagePyramid = {
  levels: [
    { path: "0", shape: [1024, 1024, 1], chunkSize: [256, 256, 1], scale: [1, 1, 1] },
    { path: "1", shape: [512, 512, 1], chunkSize: [256, 256, 1], scale: [2, 2, 1] },
    { path: "2", shape: [256, 256, 1], chunkSize: [256, 256, 1], scale: [4, 4, 1] },
  ],
};

describe("automatic pyramid selection", () => {
  test("chooses the coarsest level that does not undersample the display", () => {
    expect(pickPyramidLevel(pyramid, {
      worldUnitsPerPixel: 3,
      axes: [0, 1],
    })).toBe(1);
  });

  test("coarsens when visible storage chunks exceed the cache budget", () => {
    expect(pickPyramidLevel(pyramid, {
      worldUnitsPerPixel: 3,
      axes: [0, 1],
      bounds: { min: [0, 0], max: [1, 1] },
      tileBudget: 3,
    })).toBe(2);
  });
});


describe("visible chunk planning", () => {
  test("emits only chunks intersecting arbitrary viewport bounds", () => {
    const plan = planTiles<TilePlacement>({
      bounds: { min: [0.3, 0.3], max: [0.7, 0.7] },
      chunkSize: [256, 256],
      resSize: [1024, 1024],
      gridDim: 2,
      level: 0,
      makeTile: (gridIdx, voxelPos, level, region) => ({
        id: `${level}:${voxelPos.join(",")}`,
        gridIdx,
        voxelPos,
        level,
        chunkSize: [256, 256, 1],
        region: {
          start: [region.start[0], region.start[1], 0] as Vec3,
          size: [region.size[0], region.size[1], 1] as Vec3,
        },
      }),
    });

    expect(plan.gridOrigin).toEqual([1, 1]);
    expect(plan.gridShape).toEqual([2, 2]);
    expect(plan.tiles.map((tile) => tile.voxelPos)).toEqual([
      [256, 256],
      [512, 256],
      [256, 512],
      [512, 512],
    ]);
  });

  test("returns no chunks when the viewport does not intersect the dataset", () => {
    const plan = planTiles<TilePlacement>({
      bounds: { min: [1.2, 0.2], max: [1.4, 0.8] },
      chunkSize: [256, 256],
      resSize: [1024, 1024],
      gridDim: 2,
      level: 0,
      makeTile: (gridIdx, voxelPos, level, region) => ({
        id: `${level}:${voxelPos.join(",")}`,
        gridIdx,
        voxelPos,
        level,
        chunkSize: [256, 256, 1],
        region: {
          start: [region.start[0], region.start[1], 0],
          size: [region.size[0], region.size[1], 1],
        },
      }),
    });

    expect(plan.gridShape).toEqual([0, 4]);
    expect(plan.tiles).toHaveLength(0);
  });
});