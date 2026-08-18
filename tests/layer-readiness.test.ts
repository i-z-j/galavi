/**
 * Layer readiness notification tests (cleanup plan 4.3).
 *
 * `view(id).whenLayerReady(layerId, { signal? })` resolves once the layer
 * reports `isReady` (immediately if already ready, otherwise when the layer
 * signals through its render-request channel). Rejects on unknown layer id
 * and on abort. Headless: no GPU, rAF stubbed as in main.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewerEngine,
  registerLayer,
  type ViewerEngine,
} from "../src/advanced";
import { BaseLayer } from "../src/layer";
import { layerRegistry } from "../src/registry";
import type { Geometry, LayerParams } from "../src/layer";
import type { State } from "../src/types";

/** Layer whose readiness flips when `finish()` simulates an async load. */
class FakeAsyncLayer extends BaseLayer {
  static readonly layerType = "fake-async";

  static fromConfig(name: string): BaseLayer {
    return new FakeAsyncLayer(name);
  }

  ready = false;

  override get isReady(): boolean {
    return this.ready;
  }

  /** Simulate the async load completing (signals via the render channel). */
  finish(): void {
    this.ready = true;
    this.requestRender();
  }

  getGeometry(): Geometry {
    return {
      vertices     : new Float32Array(0),
      vertexCount  : 0,
      vertexStride : 0,
      topology     : "triangle-list",
    };
  }

  protected getLayerParams(): LayerParams {
    return { toBuffer: () => new Float32Array(4) };
  }
}

const initialState: State = {
  layers      : [{ id: "a", type: "fake-async" }],
  exploration : {
    camera: {
      navMode  : "orbit",
      projMode : "perspective",
      position : [1.13, 0.12, 1.13],
      target   : [0.5, 0.5, 0.5],
    },
  },
};

describe("view(id).whenLayerReady", () => {
  let engine: ViewerEngine | undefined;

  beforeEach(() => {
    registerLayer("fake-async", FakeAsyncLayer.fromConfig.bind(FakeAsyncLayer));
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    engine?.destroy();
    engine = undefined;
    layerRegistry.unregister("fake-async");
    vi.unstubAllGlobals();
  });

  async function setup() {
    engine = await createViewerEngine({
      state : initialState,
      views : { main: { type: "volume", layers: ["a"] } },
    });
    const layer = engine.view("main").getLayer("a") as FakeAsyncLayer;
    return { engine, layer };
  }

  test("pends while not ready, resolves when the layer signals ready", async () => {
    const { engine: g, layer } = await setup();
    let settled = false;
    const promise = g.view("main").whenLayerReady("a").then((resolved) => {
      settled = true;
      return resolved;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    layer.finish();
    await expect(promise).resolves.toBe(layer);
    expect(settled).toBe(true);
  });

  test("resolves immediately when the layer is already ready", async () => {
    const { engine: g, layer } = await setup();
    layer.finish();
    await expect(g.view("main").whenLayerReady("a")).resolves.toBe(layer);
  });

  test("rejects on an unknown layer id", async () => {
    const { engine: g } = await setup();
    await expect(g.view("main").whenLayerReady("nope"))
      .rejects.toThrow('Layer "nope" not found in view "main"');
  });

  test("rejects when the abort signal fires", async () => {
    const { engine: g } = await setup();
    const controller = new AbortController();
    const promise = g.view("main").whenLayerReady("a", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });

  test("rejects immediately for a pre-aborted signal", async () => {
    const { engine: g } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(g.view("main").whenLayerReady("a", { signal: controller.signal }))
      .rejects.toThrow(/abort/i);
  });

  test("loadStatus tracks readiness for plain async layers (DX-M2 default)", async () => {
    const { engine: g, layer } = await setup();
    expect(layer.loadError).toBeUndefined();
    expect(g.view("main").getLayerStatus("a")).toEqual({ status: "loading" });

    layer.finish();
    expect(g.view("main").getLayerStatus("a")).toEqual({ status: "ready" });
  });
});
