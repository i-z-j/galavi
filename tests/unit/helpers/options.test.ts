/**
 * Option-parsing tests — the shared `opt*` readers and the config-boundary
 * policy applied by layer `fromConfig` factories: unknown keys ignored,
 * wrong-typed values treated as absent (layer defaults apply).
 */
import { describe, expect, test } from "vitest";
import {
  optArray,
  optAxis,
  optBoolean,
  optNumber,
  optNumberRecord,
  optString,
  optVec2,
  optVec3,
} from "../../../src/utils";
import {
  PointsLayer,
  SliceLayer,
  VolumeLayer,
  type PointsLayerConfig,
  type SliceLayerConfig,
  type VolumeLayerConfig,
} from "../../../src/primitives/layer";

describe("opt* readers", () => {
  test("optNumber accepts finite numbers only", () => {
    expect(optNumber(3.5)).toBe(3.5);
    expect(optNumber(0)).toBe(0);
    expect(optNumber("3")).toBeUndefined();
    expect(optNumber(NaN)).toBeUndefined();
    expect(optNumber(Infinity)).toBeUndefined();
    expect(optNumber(undefined)).toBeUndefined();
  });

  test("optBoolean / optString accept only their primitive", () => {
    expect(optBoolean(false)).toBe(false);
    expect(optBoolean(0)).toBeUndefined();
    expect(optString("x")).toBe("x");
    expect(optString(7)).toBeUndefined();
  });

  test("optVec2 / optVec3 copy valid tuples, reject the rest", () => {
    expect(optVec2([1, 2])).toEqual([1, 2]);
    expect(optVec2([1, 2, 3])).toBeUndefined();
    expect(optVec2([1, "2"])).toBeUndefined();
    expect(optVec3([1, 2, 3])).toEqual([1, 2, 3]);
    expect(optVec3([1, 2])).toBeUndefined();
    expect(optVec3("1,2,3")).toBeUndefined();
  });

  test("optArray is all-or-nothing across items", () => {
    expect(optArray([1, 2], optNumber)).toEqual([1, 2]);
    expect(optArray([1, "x"], optNumber)).toBeUndefined();
    expect(optArray("nope", optNumber)).toBeUndefined();
    expect(optArray([[0, 1, 2]], optVec3)).toEqual([[0, 1, 2]]);
  });

  test("optAxis accepts axis names and indices", () => {
    expect(optAxis("x")).toBe("x");
    expect(optAxis(2)).toBe(2);
    expect(optAxis({})).toBeUndefined();
  });

  test("optNumberRecord requires every value to be a finite number", () => {
    expect(optNumberRecord({ c: 0, t: 5 })).toEqual({ c: 0, t: 5 });
    expect(optNumberRecord({ c: "0" })).toBeUndefined();
    expect(optNumberRecord([1, 2])).toBeUndefined();
    expect(optNumberRecord(null)).toBeUndefined();
  });
});

describe("fromConfig boundary policy", () => {
  test("volume: valid options are applied", () => {
    const layer = VolumeLayer.fromConfig("v", {
      id      : "v",
      type    : "volume",
      options : { contrastRange: [2, 4], maxPoolSize: 8 },
    });
    // contrast [2,4] → scale 1/(4-2) = 0.5 in slot 0 of the params buffer
    expect(layer.getParams().toBuffer()[0]).toBe(0.5);
  });

  test("volume: wrong-typed values fall back to layer defaults", () => {
    const desc = {
      id      : "v",
      type    : "volume",
      options : { contrastRange: "wide", maxPoolSize: "lots", selection: { c: "0" } },
    } as unknown as VolumeLayerConfig;
    const layer = VolumeLayer.fromConfig("v", desc);
    // default contrast [0,1] → scale 1
    expect(layer.getParams().toBuffer()[0]).toBe(1);
    // default selection is empty; a setSelection round-trip still works
    layer.setSelection("c", 1);
    expect(layer.dataVersion).toBe(1);
  });

  test("volume: unknown option keys are ignored", () => {
    const desc = {
      id      : "v",
      type    : "volume",
      options : { bogusKey: 123 },
    } as unknown as VolumeLayerConfig;
    expect(() => VolumeLayer.fromConfig("v", desc)).not.toThrow();
  });

  test("slice: valid axes resolve, wrong-typed axes fall back to XY", () => {
    const yz = SliceLayer.fromConfig("s", {
      id      : "s",
      type    : "slice",
      options : { axes: ["y", "z"] },
    });
    expect(yz.axisMap).toEqual([1, 2, 0]);

    const bad = SliceLayer.fromConfig("s", {
      id      : "s",
      type    : "slice",
      options : { axes: "xy" },
    } as unknown as SliceLayerConfig);
    expect(bad.axisMap).toEqual([0, 1, 2]);
  });

  test("points: malformed entry drops the whole points array", () => {
    const valid = PointsLayer.fromConfig("p", {
      id      : "p",
      type    : "points",
      options : { points: [[0, 0, 0], [1, 1, 1]] },
    });
    expect(valid.count).toBe(2);

    const invalid = PointsLayer.fromConfig("p", {
      id      : "p",
      type    : "points",
      options : { points: [[0, 0, 0], ["x", 1, 1]] },
    } as unknown as PointsLayerConfig);
    expect(invalid.count).toBe(0);
  });
});
