import { describe, expect, test } from "vitest";
import {
  CHANNEL_FALLBACK_COLORS,
  buildContrastLimits,
  clampContrastLimits,
  getChannelColor,
  normalizeHexColor,
} from "../../../src/dataset";

describe("normalizeHexColor", () => {
  test("normalizes to #RRGGBB uppercase", () => {
    expect(normalizeHexColor("00b0ff")).toBe("#00B0FF");
    expect(normalizeHexColor("#ff3d3d")).toBe("#FF3D3D");
    expect(normalizeHexColor("  FFFFFF  ")).toBe("#FFFFFF");
  });

  test("rejects malformed colors", () => {
    expect(normalizeHexColor(undefined)).toBeUndefined();
    expect(normalizeHexColor("")).toBeUndefined();
    expect(normalizeHexColor("#FFF")).toBeUndefined();
    expect(normalizeHexColor("red")).toBeUndefined();
    expect(normalizeHexColor("12345")).toBeUndefined();
  });
});

describe("getChannelColor", () => {
  test("prefers a valid metadata color", () => {
    expect(getChannelColor(0, "ff0000")).toBe("#FF0000");
  });

  test("falls back to the palette and cycles it", () => {
    expect(getChannelColor(0)).toBe(CHANNEL_FALLBACK_COLORS[0]);
    expect(getChannelColor(2, "not-a-color")).toBe(CHANNEL_FALLBACK_COLORS[2]);
    expect(getChannelColor(CHANNEL_FALLBACK_COLORS.length)).toBe(CHANNEL_FALLBACK_COLORS[0]);
  });
});

describe("clampContrastLimits", () => {
  test("defaults to the full [0,1] range", () => {
    expect(clampContrastLimits(undefined)).toEqual([0, 1]);
  });

  test("clamps into [0,1] and keeps ordering", () => {
    expect(clampContrastLimits([-0.5, 2])).toEqual([0, 1]);
    expect(clampContrastLimits([0.2, 0.8])).toEqual([0.2, 0.8]);
    expect(clampContrastLimits([0.9, 0.1])).toEqual([0.9, 0.9]);
  });
});

describe("buildContrastLimits", () => {
  test("builds per-channel limits with fallback", () => {
    expect(buildContrastLimits([[0.1, 0.9]], 3)).toEqual([[0.1, 0.9], [0, 1], [0, 1]]);
    expect(buildContrastLimits(undefined, 2)).toEqual([[0, 1], [0, 1]]);
  });
});
