/**
 * Volume render-mode tests (mip / minip / mean).
 *
 * `render.mode` is parsed per the config-boundary policy (wrong-typed or
 * unknown values fall back to "mip"), packed into the params uniform at
 * slot 31, and switched at runtime via `setRender` — a params-only update
 * that never touches geometryVersion (no pipeline rebuild).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createGalavi, type Galavi } from "../src/index";
import {
  VolumeLayer,
  VolumeLayerParams,
  optVolumeMode,
} from "../src/layer";
import type { LayerConfig } from "../src/types";

function paramsMode(layer: VolumeLayer): number {
  return layer.getParams().toBuffer()[31];
}

function applyRenderMode(layer: VolumeLayer, mode: unknown): void {
  layer.applyConfig({
    id     : layer.id,
    type   : "volume",
    render : { mode } as LayerConfig["render"],
  });
}

describe("optVolumeMode", () => {
  test("accepts the three valid modes", () => {
    expect(optVolumeMode("mip")).toBe("mip");
    expect(optVolumeMode("minip")).toBe("minip");
    expect(optVolumeMode("mean")).toBe("mean");
  });

  test("wrong-typed or unknown values read as absent", () => {
    expect(optVolumeMode(42)).toBeUndefined();
    expect(optVolumeMode(true)).toBeUndefined();
    expect(optVolumeMode({})).toBeUndefined();
    expect(optVolumeMode(["mip"])).toBeUndefined();
    expect(optVolumeMode("MIP")).toBeUndefined();
    expect(optVolumeMode("average")).toBeUndefined();
    expect(optVolumeMode(undefined)).toBeUndefined();
  });
});

describe("volume render mode", () => {
  test("params buffer packs the mode code at slot 31", () => {
    const params = new VolumeLayerParams();
    expect(params.toBuffer()).toHaveLength(32);
    expect(params.toBuffer()[31]).toBe(0); // default mip

    params.setMode("minip");
    expect(params.toBuffer()[31]).toBe(1);

    params.setMode("mean");
    expect(params.toBuffer()[31]).toBe(2);

    params.setMode("mip");
    expect(params.toBuffer()[31]).toBe(0);
  });

  test("applyConfig parses render.mode into the params (valid + default)", () => {
    const layer = VolumeLayer.fromConfig("v", { id: "v", type: "volume" });
    expect(paramsMode(layer)).toBe(0); // default before any config

    applyRenderMode(layer, "minip");
    expect(paramsMode(layer)).toBe(1);

    applyRenderMode(layer, "mean");
    expect(paramsMode(layer)).toBe(2);

    // Wrong-typed value falls back to the default, per boundary policy.
    applyRenderMode(layer, 42);
    expect(paramsMode(layer)).toBe(0);

    applyRenderMode(layer, "bogus");
    expect(paramsMode(layer)).toBe(0);

    // Absent key resets to the default.
    layer.applyConfig({ id: "v", type: "volume", render: { opacity: 0.5 } });
    expect(paramsMode(layer)).toBe(0);
  });

  test("mode change is params-only: no pipeline rebuild, no data invalidation", () => {
    const layer = VolumeLayer.fromConfig("v", { id: "v", type: "volume" });
    const geometryVersion = layer.geometryVersion;
    const dataVersion     = layer.dataVersion;

    applyRenderMode(layer, "mean");
    expect(layer.geometryVersion).toBe(geometryVersion);
    expect(layer.dataVersion).toBe(dataVersion);
  });
});

describe("setRender({ mode }) through a Galavi instance", () => {
  let galavi: Galavi | undefined;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    galavi?.destroy();
    galavi = undefined;
    vi.unstubAllGlobals();
  });

  test("propagates via the render-config path", async () => {
    galavi = await createGalavi({
      state: {
        layers      : [{ id: "v", type: "volume" }],
        exploration : {
          camera: {
            navMode  : "orbit",
            projMode : "perspective",
            position : [1.13, 0.12, 1.13],
            target   : [0.5, 0.5, 0.5],
          },
        },
      },
      views: { main: { type: "volume", layers: ["v"] } },
    });

    galavi.layer("v")!.setRender({ mode: "minip" });
    expect(galavi.layer("v")!.config.render?.mode).toBe("minip");

    // The state entry feeds the layer through the standard applyConfig path.
    const desc = galavi.getState().layers.find((l) => l.id === "v")!;
    const layer = galavi.view("main").getLayer("v") as VolumeLayer;
    layer.applyConfig(desc);
    expect(paramsMode(layer)).toBe(1);

    galavi.layer("v")!.setRender({ mode: "mean" });
    layer.applyConfig(galavi.getState().layers.find((l) => l.id === "v")!);
    expect(paramsMode(layer)).toBe(2);
    expect(layer.geometryVersion).toBe(0);
  });
});
