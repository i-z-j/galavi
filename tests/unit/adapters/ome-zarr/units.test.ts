/**
 * Unit normalization tests. Pins current behavior: `undefined` for a
 * missing unit (no invented fallback) and passthrough for unknown units.
 */
import { describe, expect, it } from "vitest";
import { normalizeUnit } from "../../../../src/dataset/adapters/ome-zarr";

describe("normalizeUnit", () => {
  it("normalizes micrometer variants to μm", () => {
    expect(normalizeUnit("µm")).toBe("μm"); // micro sign
    expect(normalizeUnit("μm")).toBe("μm"); // greek small letter mu
    expect(normalizeUnit("um")).toBe("μm");
    expect(normalizeUnit("micrometer")).toBe("μm");
    expect(normalizeUnit("micrometre")).toBe("μm");
    expect(normalizeUnit(" Micrometer ")).toBe("μm"); // trimmed, case-insensitive
  });

  it("normalizes millimeter and nanometer variants", () => {
    expect(normalizeUnit("mm")).toBe("mm");
    expect(normalizeUnit("millimeter")).toBe("mm");
    expect(normalizeUnit("millimetre")).toBe("mm");
    expect(normalizeUnit("nm")).toBe("nm");
    expect(normalizeUnit("nanometer")).toBe("nm");
    expect(normalizeUnit("nanometre")).toBe("nm");
  });

  it("passes unknown units through unchanged (original casing kept)", () => {
    expect(normalizeUnit("cm")).toBe("cm");
    expect(normalizeUnit("pixel")).toBe("pixel");
  });

  it("returns undefined when the unit is missing (no invented fallback)", () => {
    expect(normalizeUnit(undefined)).toBeUndefined();
  });
});
