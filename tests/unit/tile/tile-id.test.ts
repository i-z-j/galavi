import { describe, expect, test } from "vitest";
import { tileId } from "../../../src/viewer/tile/planner";

// Pins the byte-for-byte tile ID strings produced by the layers' makeTile:
// volume `tileId(level, voxelPos)`, slice `tileId(level, [sliceIdx, ...voxelPos])`.
describe("tileId", () => {
  test("volume placement IDs are `${level}:${voxelPos.join(\",\")}`", () => {
    const level = 2;
    const voxelPos = [1, 2, 3];
    expect(tileId(level, voxelPos)).toBe(`${level}:${voxelPos.join(",")}`);
    expect(tileId(level, voxelPos)).toBe("2:1,2,3");
  });

  test("slice placement IDs are `${level}:${sliceIdx},${voxelPos.join(\",\")}`", () => {
    const level = 1;
    const sliceIdx = 4;
    const voxelPos = [5, 6];
    expect(tileId(level, [sliceIdx, ...voxelPos]))
      .toBe(`${level}:${sliceIdx},${voxelPos.join(",")}`);
    expect(tileId(level, [sliceIdx, ...voxelPos])).toBe("1:4,5,6");
  });

  test("formats 2D tile coordinates", () => {
    expect(tileId(0, [256, 256])).toBe("0:256,256");
  });
});
