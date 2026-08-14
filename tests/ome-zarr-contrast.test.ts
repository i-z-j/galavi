/**
 * Contrast normalization tests: window start/end vs min/max precedence,
 * clamping to [0, 1], and rejection of degenerate windows.
 */
import { describe, expect, it } from "vitest";
import { getNormalizedDisplayContrast } from "../src/dataset/ome-zarr";

describe("getNormalizedDisplayContrast", () => {
  it("normalizes start/end against the dtype range", () => {
    expect(getNormalizedDisplayContrast({ start: 0, end: 255 }, 255)).toEqual([0, 1]);
    expect(getNormalizedDisplayContrast({ start: 64, end: 192 }, 255)).toEqual([64 / 255, 192 / 255]);
  });

  it("prefers start/end over min/max when both are present", () => {
    expect(
      getNormalizedDisplayContrast({ start: 64, end: 192, min: 0, max: 255 }, 255),
    ).toEqual([64 / 255, 192 / 255]);
  });

  it("falls back to min/max when start/end are absent or invalid", () => {
    expect(getNormalizedDisplayContrast({ min: 0, max: 128 }, 255)).toEqual([0, 128 / 255]);
    // start present but end missing -> explicit pair invalid -> min/max used
    expect(
      getNormalizedDisplayContrast({ start: 64, min: 0, max: 128 }, 255),
    ).toEqual([0, 128 / 255]);
  });

  it("clamps out-of-range window values to [0, 1]", () => {
    expect(getNormalizedDisplayContrast({ start: -100, end: 300 }, 255)).toEqual([0, 1]);
  });

  it("returns undefined for degenerate or incomplete windows", () => {
    expect(getNormalizedDisplayContrast({}, 255)).toBeUndefined();
    expect(getNormalizedDisplayContrast({ start: 100, end: 100 }, 255)).toBeUndefined();
    expect(getNormalizedDisplayContrast({ start: 200, end: 100 }, 255)).toBeUndefined();
    expect(getNormalizedDisplayContrast({ min: 0, max: Infinity }, 255)).toBeUndefined();
    expect(getNormalizedDisplayContrast({ min: NaN, max: 1 }, 255)).toBeUndefined();
  });

  it("treats a non-positive dtype range as scale 1", () => {
    expect(getNormalizedDisplayContrast({ start: 0.25, end: 0.75 }, 0)).toEqual([0.25, 0.75]);
  });
});
