/**
 * Level scale derivation: when a level carries no coordinateTransformations,
 * its physical voxel scale is derived from the finest level's scale and the
 * shape ratio.
 */
import { describe, expect, it } from "vitest";
import { deriveLevelScale } from "../src/dataset/ome-zarr";

describe("deriveLevelScale", () => {
  it("scales by the shape ratio against the finest level", () => {
    expect(deriveLevelScale([0.5, 0.5, 2], [1000, 1000, 50], [500, 500, 25])).toEqual([1, 1, 4]);
    expect(deriveLevelScale([0.5, 0.5, 2], [1000, 1000, 50], [250, 250, 13])).toEqual([
      0.5 * 1000 / 250,
      0.5 * 1000 / 250,
      2 * 50 / 13,
    ]);
  });

  it("returns the finest scale unchanged for the finest shape", () => {
    expect(deriveLevelScale([0.5, 0.5, 2], [1000, 1000, 50], [1000, 1000, 50])).toEqual([0.5, 0.5, 2]);
  });
});
