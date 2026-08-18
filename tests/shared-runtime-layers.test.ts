/**
 * Shared runtime layer tests (ARCH-1).
 *
 * The ViewerEngine owns one `BaseLayer` instance per state-layer ID, shared
 * by every referencing view, with one tracked async load and one engine-side
 * render-request channel per layer. These tests pin down:
 *
 * - two views referencing one layer ID return the same instance;
 * - `initAsync` and the source fetch run exactly once for a shared layer;
 * - a failed source rejects `whenLayerReady` in every referencing view,
 *   records `loadError`, and never hangs in `"loading"`;
 * - no unhandled promise rejections on failure;
 * - retry/abort/remove/destroy precedence for readiness waiters;
 * - state updates (`setRender`/`setData`) apply to the single shared
 *   instance seen by all referencing views.
 *
 * Headless: a minimal fake WebGPU device + fake canvases let real views
 * mount (rAF is stubbed — no render pass runs).
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
import type { LayerConfig, State } from "../src/types";

// ============================================================================
// FAKE LAYERS
// ============================================================================

/** Layer whose tracked load succeeds/fails per static behavior; counts runs. */
class FlakyLayer extends BaseLayer {
  static readonly layerType = "flaky";
  static behavior: "ok" | "fail" = "ok";
  static initCalls = 0;

  static fromConfig(name: string): BaseLayer {
    return new FlakyLayer(name);
  }

  ready = false;

  override get isReady(): boolean {
    return this.ready;
  }

  override async initAsync(): Promise<void> {
    FlakyLayer.initCalls++;
    if (FlakyLayer.behavior === "fail") throw new Error("flaky init failed");
    this.ready = true;
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

// ============================================================================
// FAKE DOM + WEBGPU
// ============================================================================

const OBJ = [
  "v 0 0 0",
  "v 1 0 0",
  "v 0 1 0",
  "f 1 2 3",
  "",
].join("\n");

function makeFakeCanvas(): HTMLCanvasElement {
  const el: Record<string, unknown> = {
    tagName: "CANVAS",
    style: {},
    clientWidth: 256,
    clientHeight: 256,
    width: 0,
    height: 0,
    parentElement: null,
    parentNode: null,
    getContext: () => ({ configure() {}, unconfigure() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
    setAttribute() {},
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
  };
  return el as unknown as HTMLCanvasElement;
}

function stubWebGPU(): void {
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {}, width: 1, height: 1 }),
    destroy() {},
    queue: {
      writeBuffer() {},
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, STORAGE: 0x80 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x01, COPY_DST: 0x08 });
  vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

/** Response stub routing: url → response or failure, counting calls per url. */
function stubFetchRouter(
  handler: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn((input: unknown) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> };

interface Gate {
  promise : Promise<FakeResponse>;
  resolve : (value: FakeResponse) => void;
}

function makeGate(): Gate {
  let resolve!: (value: FakeResponse) => void;
  const promise = new Promise<FakeResponse>((res) => { resolve = res; });
  return { promise, resolve };
}

function failResponse(status: number): FakeResponse {
  return { ok: false, status, text: async () => "" };
}

function okResponse(body = OBJ) {
  return { ok: true, status: 200, text: async () => body };
}

async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const CAMERA = {
  navMode  : "orbit",
  projMode : "perspective",
  position : [1.13, 0.12, 1.13],
  target   : [0.5, 0.5, 0.5],
} as const;

function makeState(layers: LayerConfig[]): State {
  return { layers, exploration: { camera: { ...CAMERA, position: [...CAMERA.position], target: [...CAMERA.target] } } };
}

// ============================================================================
// HARNESS
// ============================================================================

let engines: ViewerEngine[];

beforeEach(() => {
  engines = [];
  stubWebGPU();
  FlakyLayer.behavior = "ok";
  FlakyLayer.initCalls = 0;
  registerLayer("flaky", FlakyLayer.fromConfig.bind(FlakyLayer));
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  layerRegistry.unregister("flaky");
  vi.unstubAllGlobals();
});

async function makeEngine(
  layers: LayerConfig[],
  viewIds: string[],
  layerIds: string[],
): Promise<ViewerEngine> {
  const views: Record<string, { type: string; canvas: HTMLCanvasElement; layers: string[] }> = {};
  for (const id of viewIds) {
    views[id] = { type: "volume", canvas: makeFakeCanvas(), layers: layerIds };
  }
  const engine = await createViewerEngine({ state: makeState(layers), views });
  engines.push(engine);
  return engine;
}

// ============================================================================
// SHARED IDENTITY + ONE LOAD
// ============================================================================

describe("shared runtime layers (ARCH-1)", () => {
  test("two views referencing one layer ID return the same instance", async () => {
    stubFetchRouter(async () => okResponse());
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://s.obj" } }],
      ["a", "b"],
      ["s"],
    );
    const fromA = engine.view("a").getLayer("s");
    const fromB = engine.view("b").getLayer("s");
    expect(fromA).toBeDefined();
    expect(fromA).toBe(fromB);
  });

  test("initAsync runs exactly once for a layer referenced by two views", async () => {
    const engine = await makeEngine([{ id: "f", type: "flaky" }], ["a", "b"], ["f"]);
    await engine.view("a").whenLayerReady("f");
    await engine.view("b").whenLayerReady("f");
    expect(FlakyLayer.initCalls).toBe(1);
  });

  test("a shared surface is fetched exactly once; both views await the same layer", async () => {
    const fetchSpy = stubFetchRouter(async () => okResponse());
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://s.obj" } } ],
      ["a", "b"],
      ["s"],
    );
    const [layerA, layerB] = await Promise.all([
      engine.view("a").whenLayerReady("s"),
      engine.view("b").whenLayerReady("s"),
    ]);
    expect(layerA).toBe(layerB);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("mem://s.obj");
    expect(engine.view("a").getLayerStatus("s")).toEqual({ status: "ready" });
    expect(engine.view("b").getLayerStatus("s")).toEqual({ status: "ready" });
  });

  test("state updates apply to the single shared instance seen by all views", async () => {
    stubFetchRouter(async () => okResponse());
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://s.obj" } }],
      ["a", "b"],
      ["s"],
    );
    const layer = await engine.view("a").whenLayerReady("s");

    engine.layer("s")!.setRender({ opacity: 0.4 });
    // Headless: no render pass runs — drive the per-frame applyConfig call
    // `BaseView.render` makes (same pattern as volume-mode.test.ts).
    const state = engine.getState();
    layer.applyConfig(state.layers.find((l) => l.id === "s")!, state.physical);
    expect(layer.opacity).toBe(0.4);
    // Both views hold the same instance, so both observe the update.
    expect(engine.view("b").getLayer("s")).toBe(layer);
    expect(engine.layer("s")!.config.render?.opacity).toBe(0.4);
  });
});

// ============================================================================
// FAILURE SEMANTICS
// ============================================================================

describe("shared layer failure semantics (ARCH-1)", () => {
  test("a failed initAsync rejects waiters in every referencing view", async () => {
    FlakyLayer.behavior = "fail";
    const engine = await makeEngine([{ id: "f", type: "flaky" }], ["a", "b"], ["f"]);
    await expect(engine.view("a").whenLayerReady("f")).rejects.toThrow("flaky init failed");
    await expect(engine.view("b").whenLayerReady("f")).rejects.toThrow("flaky init failed");
    const layer = engine.view("a").getLayer("f")!;
    expect(layer.loadStatus).toBe("error"); // never permanently "loading"
    expect(layer.loadError).toBeInstanceOf(Error);
    expect(engine.view("a").getLayerStatus("f")).toEqual({ status: "error", error: layer.loadError });
    expect(engine.view("b").getLayerStatus("f")).toEqual({ status: "error", error: layer.loadError });
  });

  test("a failed surface rejects whenLayerReady in every referencing view", async () => {
    const gate = makeGate();
    stubFetchRouter(() => gate.promise);
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://missing.obj" } }],
      ["a", "b"],
      ["s"],
    );
    // Waiters registered while the load is in flight…
    const pendingA = engine.view("a").whenLayerReady("s");
    const pendingB = engine.view("b").whenLayerReady("s");
    gate.resolve(failResponse(404));
    await expect(pendingA).rejects.toThrow("Surface fetch failed: 404");
    await expect(pendingB).rejects.toThrow("Surface fetch failed: 404");
    // …and calls made after the failure settled both reject with the error.
    await expect(engine.view("a").whenLayerReady("s")).rejects.toThrow("Surface fetch failed: 404");
    const layer = engine.view("a").getLayer("s")!;
    expect(layer.loadStatus).toBe("error");
    expect(layer.loadError?.message).toBe("Surface fetch failed: 404");
  });

  test("no unhandled promise rejection when a shared layer fails with no waiters", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      stubFetchRouter(async () => ({ ok: false, status: 500, text: async () => "" }));
      const engine = await makeEngine(
        [{ id: "s", type: "surface", data: { url: "mem://fails.obj" } }],
        ["a", "b"],
        ["s"],
      );
      // No whenLayerReady waiters at all — the engine's fan-out owns the
      // tracked promise. Await the layer's own tracked load to sync up.
      await expect(engine.view("a").getLayer("s")!.ensureLoaded()).rejects.toThrow(
        "Surface fetch failed: 500",
      );
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
      expect(engine.view("a").getLayerStatus("s")?.status).toBe("error");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

// ============================================================================
// RETRY / PRECEDENCE
// ============================================================================

describe("shared layer retry and precedence (ARCH-1)", () => {
  /** Drive the state-config path against the shared instance (rAF is stubbed). */
  function applyConfig(engine: ViewerEngine, id: string): void {
    const state = engine.getState();
    const desc = state.layers.find((l) => l.id === id)!;
    engine.view("a").getLayer(id)!.applyConfig(desc, state.physical);
  }

  test("source retry clears the error and resolves all current waiters", async () => {
    const fetchSpy = stubFetchRouter(async (url) =>
      url === "mem://bad.obj"
        ? { ok: false, status: 404, text: async () => "" }
        : okResponse(),
    );
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://bad.obj" } }],
      ["a", "b"],
      ["s"],
    );
    await expect(engine.view("a").whenLayerReady("s")).rejects.toThrow("Surface fetch failed: 404");
    const layer = engine.view("a").getLayer("s")!;
    expect(layer.loadStatus).toBe("error");

    // Retry with a fixed URL through the state path.
    engine.layer("s")!.setData({ url: "mem://good.obj" });
    applyConfig(engine, "s");

    // The old error is cleared up front — the layer is loading again.
    expect(layer.loadError).toBeUndefined();
    expect(layer.loadStatus).toBe("loading");

    // Waiters of the new generation resolve in every referencing view.
    const [layerA, layerB] = await Promise.all([
      engine.view("a").whenLayerReady("s"),
      engine.view("b").whenLayerReady("s"),
    ]);
    expect(layerA).toBe(layer);
    expect(layerB).toBe(layer);
    expect(layer.loadStatus).toBe("ready");
    expect(fetchSpy).toHaveBeenCalledTimes(2); // one fetch per generation

    // Re-applying the SAME source is a no-op (sourceChanged guard).
    engine.layer("s")!.setData({ url: "mem://good.obj" });
    applyConfig(engine, "s");
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(layer.loadStatus).toBe("ready");
  });

  test("abort settles only its own waiter; the failure still rejects the rest", async () => {
    const gate = makeGate();
    stubFetchRouter(() => gate.promise);
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://missing.obj" } }],
      ["a"],
      ["s"],
    );
    const controller = new AbortController();
    const aborted = engine.view("a").whenLayerReady("s", { signal: controller.signal });
    const regular = engine.view("a").whenLayerReady("s");
    controller.abort();
    gate.resolve(failResponse(404));
    await expect(aborted).rejects.toThrow(/abort/i);
    await expect(regular).rejects.toThrow("Surface fetch failed: 404");
  });

  test("a pre-aborted signal rejects with the abort reason even in the error state", async () => {
    const gate = makeGate();
    stubFetchRouter(() => gate.promise);
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://missing.obj" } }],
      ["a"],
      ["s"],
    );
    const pending = engine.view("a").whenLayerReady("s");
    gate.resolve(failResponse(404));
    await expect(pending).rejects.toThrow("Surface fetch failed: 404");
    const controller = new AbortController();
    controller.abort();
    await expect(engine.view("a").whenLayerReady("s", { signal: controller.signal }))
      .rejects.toThrow(/abort/i);
  });

  test("removing the layer from one view rejects that view's waiters only", async () => {
    const gate = makeGate();
    stubFetchRouter(() => gate.promise);
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://s.obj" } }],
      ["a", "b"],
      ["s"],
    );
    const removed = engine.view("b").whenLayerReady("s");
    const kept = engine.view("a").whenLayerReady("s");
    engine.view("b").base.removeLayer(engine.view("b").getLayer("s")!);
    gate.resolve(okResponse());
    await expect(removed).rejects.toThrow('Layer "s" removed from view "b"');
    await expect(kept).resolves.toBe(engine.view("a").getLayer("s")!);
  });

  test("destroying the engine rejects pending waiters and late settles go quiet", async () => {
    let resolveFetch!: (value: { ok: boolean; status: number; text: () => Promise<string> }) => void;
    stubFetchRouter(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const engine = await makeEngine(
      [{ id: "s", type: "surface", data: { url: "mem://slow.obj" } }],
      ["a"],
      ["s"],
    );
    const pending = engine.view("a").whenLayerReady("s");
    engine.destroy();
    await expect(pending).rejects.toThrow('View "a" destroyed');
    // The in-flight fetch settles after destroy — nothing unhandled, nothing throws.
    resolveFetch(okResponse());
    await flushMicrotasks();
  });
});
