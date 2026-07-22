import { describe, expect, test } from "bun:test";
import {
  buildSliceOrientations,
  canonicalToStorageIndex,
  parseAnatomicalOrientation,
} from "../src/utils/anatomical-orientation";

describe("parseAnatomicalOrientation", () => {
  test("maps M1779 raw ZYX axes into normalized XYZ storage axes", () => {
    expect(parseAnatomicalOrientation("asr", "ZYX")).toEqual({
      A: { storageAxis: 2, storageName: "z", sign: -1 },
      S: { storageAxis: 1, storageName: "y", sign: -1 },
      R: { storageAxis: 0, storageName: "x", sign: -1 },
    });
  });

  test("preserves every direction sign", () => {
    expect(parseAnatomicalOrientation("Asr", "ZYX")).toEqual({
      A: { storageAxis: 2, storageName: "z", sign: 1 },
      S: { storageAxis: 1, storageName: "y", sign: -1 },
      R: { storageAxis: 0, storageName: "x", sign: -1 },
    });
  });

  test("rejects incomplete anatomical mappings", () => {
    expect(() => parseAnatomicalOrientation("ARR", "ZYX")).toThrow("Invalid RAS_coordinate");
  });
});

describe("buildSliceOrientations", () => {
  test("keeps M1779 coronal and horizontal planes while transposing sagittal", () => {
    // 'asr' maps every anatomical axis to a negative direction → nothing reversed.
    expect(buildSliceOrientations("asr", "ZYX")).toEqual({
      xy: {
        axes: ["x", "y"],
        axisMap: [0, 1, 2],
        sourcePlane: "xy",
        reversed: [false, false, false],
      },
      xz: {
        axes: ["x", "z"],
        axisMap: [0, 2, 1],
        sourcePlane: "xz",
        reversed: [false, false, false],
      },
      yz: {
        axes: ["z", "y"],
        axisMap: [2, 1, 0],
        sourcePlane: "yz",
        reversed: [false, false, false],
      },
    });
  });

  test("derives every BB001 plane from its ARS orientation", () => {
    expect(buildSliceOrientations("ARS", "ZYX")).toEqual({
      xy: {
        axes: ["y", "x"],
        axisMap: [1, 0, 2],
        sourcePlane: "xy",
        reversed: [true, true, true],
      },
      xz: {
        axes: ["y", "z"],
        axisMap: [1, 2, 0],
        sourcePlane: "yz",
        reversed: [true, true, true],
      },
      yz: {
        axes: ["z", "x"],
        axisMap: [2, 0, 1],
        sourcePlane: "xz",
        reversed: [true, true, true],
      },
    });
  });
});

describe("canonicalToStorageIndex", () => {
  test("reverses first and last slices when storage points toward the uppercase direction", () => {
    expect(canonicalToStorageIndex(0, 10, true)).toBe(9);
    expect(canonicalToStorageIndex(9, 10, true)).toBe(0);
  });

  test("preserves and clamps slices when storage already follows display order", () => {
    expect(canonicalToStorageIndex(-2, 10, false)).toBe(0);
    expect(canonicalToStorageIndex(12, 10, false)).toBe(9);
  });
});
