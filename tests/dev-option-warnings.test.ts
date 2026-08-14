/**
 * Dev-only unknown-option-key diagnostics (DX-Q1).
 *
 * Built-in tiled image layers (VolumeLayer / SliceLayer) warn on option keys
 * they do not recognize — at construction and when options are applied (the
 * `setOptions` path drives `applyConfig`). The warning names the layer id and
 * the stray keys and points at `options.selection`; unknown keys remain
 * ignored (never a throw). Vitest runs with `import.meta.env.DEV === true`,
 * so the guard is active here; production builds drop the branch entirely.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SliceLayer,
  VolumeLayer,
  type SliceConfig,
  type SliceLayerConfig,
  type VolumeConfig,
  type VolumeLayerConfig,
} from "../src/layer";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Flatten all console.warn calls into one string for content assertions. */
function warnedText(): string {
  return warnSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("unknown option keys warn (dev diagnostics)", () => {
  test("volume: top-level `c` warns at construction, naming layer id and key", () => {
    new VolumeLayer("vol-c2", { c: 2 } as unknown as VolumeConfig);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const text = warnedText();
    expect(text).toContain("vol-c2");
    expect(text).toContain('"c"');
    expect(text).toContain("options.selection");
  });

  test("slice: top-level `z` warns at construction", () => {
    new SliceLayer("slice-xy", { z: 3 } as unknown as SliceConfig);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnedText()).toContain('"z"');
  });

  test("unknown keys stay ignored — construction never throws", () => {
    expect(() => (
      new VolumeLayer("v", { c: 2, bogus: true } as unknown as VolumeConfig)
    )).not.toThrow();
  });

  test("volume: unknown keys warn on applyConfig (the setOptions path)", () => {
    const layer = VolumeLayer.fromConfig("v", {
      id      : "v",
      type    : "volume",
      options : { selection: { c: 0 } },
    });
    expect(warnSpy).not.toHaveBeenCalled();

    layer.applyConfig({
      id      : "v",
      type    : "volume",
      options : { c: 2 },
    } as unknown as VolumeLayerConfig);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnedText()).toContain('"c"');
  });

  test("slice: unknown keys warn on applyConfig (the setOptions path)", () => {
    const layer = SliceLayer.fromConfig("s", { id: "s", type: "slice" });
    layer.applyConfig({
      id      : "s",
      type    : "slice",
      options : { t: 1 },
    } as unknown as SliceLayerConfig);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnedText()).toContain('"t"');
  });
});

describe("recognized option keys do not warn", () => {
  test("nested selection is the correct home for dimension keys", () => {
    new VolumeLayer("v", { selection: { c: 2 } });
    new SliceLayer("s", { selection: { c: 2, t: 5 } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("volume: all known keys are silent at construction and on applyConfig", () => {
    const options = {
      source        : { url: "https://example.org/{z}/{y}/{x}" },
      maxPoolSize   : 8,
      selection     : { c: 1 },
      region        : { min: [0, 0, 0], max: [1, 1, 1] },
      finestLevel   : true,
      contrastRange : [0.1, 0.9],
      timepoint     : 2,
    } as unknown as VolumeConfig;
    const layer = new VolumeLayer("v", options);
    layer.applyConfig({ id: "v", type: "volume", options } as unknown as VolumeLayerConfig);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("slice: slice-specific keys (axes, mipThickness, sliceIndex) are silent", () => {
    const options = {
      axes         : ["y", "z"],
      mipThickness : 2,
      sliceIndex   : 4,
      selection    : { c: 0 },
    } as unknown as SliceConfig;
    const layer = new SliceLayer("s", options);
    layer.applyConfig({ id: "s", type: "slice", options } as unknown as SliceLayerConfig);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
