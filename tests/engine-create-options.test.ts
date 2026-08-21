/**
 * createViewerEngine creation-options tests (R7): `{ signal, waitUntil }`.
 *
 * - `waitUntil: "mounted"` (default) resolves after GPU init + mount, without
 *   waiting for layers; `waitUntil: "layers"` awaits STRUCTURAL readiness
 *   (source/pyramid available — not first presented pixels) of every unique
 *   configured layer across all views, deduplicated by layer ID, and rejects
 *   with the recorded layer load error on failure.
 * - `signal` aborts creation before GPU init, during mount, or during the
 *   layer wait: the promise rejects with `signal.reason` (an AbortError
 *   DOMException by default) and the partially created engine is destroyed
 *   exactly once — GPU device released, layers detached — with no late render
 *   activity afterwards.
 *
 * Headless: fake WebGPU device + fake canvases (rAF is queued and flushed
 * manually, so late render activity is observable).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewerEngine,
  registerLayer,
  registerView,
  type ViewerEngine,
} from "../src/advanced";
import { BaseLayer, type Geometry, type LayerParams } from "../src/layer";
import { BaseView } from "../src/view";
import { layerRegistry, viewRegistry } from "../src/registry";
import type { LayerConfig, State, ViewConfig } from "../src/types";

// ============================================================================
// FAKE LAYERS + VIEWS
// ============================================================================

/** Per-layer behavior, keyed by layer ID; set before engine creation. */
let behaviors: Map<string, { pending?: boolean; failWith?: Error }>;
/** Registry-made instances, for driving readiness from the test. */
let instances: Map<string, GatedLayer>;

/** Layer whose structural readiness is driven externally (or fails/pends). */
class GatedLayer extends BaseLayer {
  static readonly layerType = "gated";
  static fromConfig(name: string): BaseLayer {
    const layer = new GatedLayer(name);
    const behavior = behaviors.get(name);
    if (behavior?.pending) layer.neverLoads = true;
    if (behavior?.failWith) layer.failWith = behavior.failWith;
    instances.set(name, layer);
    return layer;
  }

  ready = false;
  neverLoads = false;
  failWith?: Error;

  override get isReady(): boolean {
    return this.ready;
  }

  override async initAsync(): Promise<void> {
    if (this.failWith) throw this.failWith;
    if (this.neverLoads) await new Promise(() => {});
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

/** View that counts rendered frames — the late-activity probe. */
class CountingView extends BaseView {
  static readonly viewType = "counting";
  static frames = 0;

  protected async initGPUResources(): Promise<void> {}
  protected renderFrame(_state: State): void {
    CountingView.frames++;
  }
}

// ============================================================================
// FAKE DOM + WEBGPU
// ============================================================================

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

let deviceDestroy: ReturnType<typeof vi.fn>;
let requestAdapterSpy: ReturnType<typeof vi.fn>;
let fakeDevice: Record<string, unknown>;
/** When set, `requestDevice` pends until the test resolves the gate. */
let deviceGate: Promise<unknown> | undefined;

function stubWebGPU(): void {
  deviceDestroy = vi.fn();
  deviceGate = undefined;
  fakeDevice = {
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {}, width: 1, height: 1 }),
    destroy: deviceDestroy,
    queue: {
      writeBuffer() {},
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  requestAdapterSpy = vi.fn(async () => ({
    requestDevice: () => deviceGate ?? Promise.resolve(fakeDevice),
  }));
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: requestAdapterSpy,
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, STORAGE: 0x80 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x01, COPY_DST: 0x08 });
  vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
}

// rAF is queued, never auto-run: tests flush manually to observe late work.
let rafQueue: Map<number, FrameRequestCallback>;
let rafId: number;

function stubRaf(): void {
  rafQueue = new Map();
  rafId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafQueue.delete(id); });
}

function flushRaf(): void {
  const callbacks = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of callbacks) cb(performance.now());
}

async function flushMicrotasks(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const CAMERA = {
  navMode  : "orbit",
  projMode : "perspective",
  position : [1.13, 0.12, 1.13],
  target   : [0.5, 0.5, 0.5],
} as const;

function makeState(layers: LayerConfig[]): State {
  return {
    layers,
    exploration: { camera: { ...CAMERA, position: [...CAMERA.position], target: [...CAMERA.target] } },
  };
}

function makeViews(entries: Record<string, string[]>, withCanvas = true): Record<string, ViewConfig> {
  const views: Record<string, ViewConfig> = {};
  for (const [id, layers] of Object.entries(entries)) {
    views[id] = {
      type    : "counting",
      layers,
      ...(withCanvas ? { canvas: makeFakeCanvas() } : {}),
    };
  }
  return views;
}

// ============================================================================
// HARNESS
// ============================================================================

let engines: ViewerEngine[];

beforeEach(() => {
  engines = [];
  behaviors = new Map();
  instances = new Map();
  CountingView.frames = 0;
  stubWebGPU();
  stubRaf();
  registerLayer("gated", GatedLayer.fromConfig.bind(GatedLayer));
  registerView("counting", (id) => new CountingView(id));
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  layerRegistry.unregister("gated");
  viewRegistry.unregister("counting");
  vi.unstubAllGlobals();
});

function track(engine: ViewerEngine): ViewerEngine {
  engines.push(engine);
  return engine;
}

// ============================================================================
// waitUntil
// ============================================================================

describe('createViewerEngine waitUntil: "layers"', () => {
  test('default ("mounted") resolves without waiting for layer readiness', async () => {
    const engine = track(await createViewerEngine({
      state : makeState([{ id: "a", type: "gated" }]),
      views : makeViews({ main: ["a"] }),
    }));
    expect(engine.view("main").getLayerStatus("a")).toEqual({ status: "loading" });
  });

  test("zero layers resolves at mount", async () => {
    const engine = track(await createViewerEngine(
      { state: makeState([]), views: makeViews({ main: [] }) },
      { waitUntil: "layers" },
    ));
    expect(engine).toBeDefined();
  });

  test("one layer: pends until the layer reports structural readiness", async () => {
    let settled = false;
    const pending = createViewerEngine(
      { state: makeState([{ id: "a", type: "gated" }]), views: makeViews({ main: ["a"] }) },
      { waitUntil: "layers" },
    ).then((engine) => { settled = true; return track(engine); });

    await flushMicrotasks();
    expect(settled).toBe(false); // mounted, but the layer is not ready yet

    instances.get("a")!.finish();
    const engine = await pending;
    expect(settled).toBe(true);
    expect(engine.view("main").getLayerStatus("a")).toEqual({ status: "ready" });
  });

  test("a layer duplicated across views is awaited once", async () => {
    const readySpy = vi.spyOn(BaseView.prototype, "whenLayerReady");
    const pending = createViewerEngine(
      { state: makeState([{ id: "shared", type: "gated" }]), views: makeViews({ a: ["shared"], b: ["shared"] }) },
      { waitUntil: "layers" },
    );
    await flushMicrotasks();
    // One runtime layer, one waiter — through the first referencing view.
    expect(readySpy).toHaveBeenCalledTimes(1);

    instances.get("shared")!.finish();
    track(await pending);
    readySpy.mockRestore();
  });

  test("multiple layers: every one must settle", async () => {
    let settled = false;
    const pending = createViewerEngine(
      {
        state : makeState([{ id: "a", type: "gated" }, { id: "b", type: "gated" }]),
        views : makeViews({ main: ["a", "b"] }),
      },
      { waitUntil: "layers" },
    ).then((engine) => { settled = true; return track(engine); });

    await flushMicrotasks();
    instances.get("a")!.finish();
    await flushMicrotasks();
    expect(settled).toBe(false); // still gated on "b"

    instances.get("b")!.finish();
    track(await pending);
    expect(settled).toBe(true);
  });

  test("a recorded layer load failure rejects with the error and destroys the engine", async () => {
    const marker = new Error("source exploded");
    behaviors.set("bad", { failWith: marker });

    await expect(createViewerEngine(
      { state: makeState([{ id: "bad", type: "gated" }]), views: makeViews({ main: ["bad"] }) },
      { waitUntil: "layers" },
    )).rejects.toBe(marker); // the recorded cause, unchanged

    expect(deviceDestroy).toHaveBeenCalledTimes(1);
  });

  test("without canvases, \"layers\" still initializes the GPU and awaits loads", async () => {
    let settled = false;
    const pending = createViewerEngine(
      { state: makeState([{ id: "a", type: "gated" }]), views: makeViews({ main: ["a"] }, false) },
      { waitUntil: "layers" },
    ).then((engine) => { settled = true; return track(engine); });

    await flushMicrotasks();
    expect(requestAdapterSpy).toHaveBeenCalledTimes(1); // layer loads are GPU-gated
    expect(settled).toBe(false);

    instances.get("a")!.finish();
    track(await pending);
    expect(settled).toBe(true);
  });
});

// ============================================================================
// signal
// ============================================================================

describe("createViewerEngine signal", () => {
  test("a pre-aborted signal rejects before GPU init — nothing allocated", async () => {
    const controller = new AbortController();
    controller.abort();
    const reason = controller.signal.reason as DOMException;
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe("AbortError");

    await expect(createViewerEngine(
      { state: makeState([{ id: "a", type: "gated" }]), views: makeViews({ main: ["a"] }) },
      { signal: controller.signal },
    )).rejects.toBe(reason);

    expect(requestAdapterSpy).not.toHaveBeenCalled();
    expect(deviceDestroy).not.toHaveBeenCalled();
    expect(instances.size).toBe(0); // the engine was never constructed
  });

  test("abort during mount rejects with the reason and releases the late device exactly once", async () => {
    let resolveDevice!: (device: unknown) => void;
    deviceGate = new Promise((res) => { resolveDevice = res; });
    const controller = new AbortController();
    const pending = createViewerEngine(
      { state: makeState([]), views: makeViews({ main: [] }) },
      { signal: controller.signal },
    );

    await flushMicrotasks(); // mount is in flight inside requestDevice
    controller.abort();
    // The abort wins the race; the factory drains the in-flight mount before
    // teardown, so the device assigned mid-flight is still released.
    resolveDevice(fakeDevice);

    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(deviceDestroy).toHaveBeenCalledTimes(1); // exactly once
  });

  test("abort during the layer wait rejects with the reason, tears down once, stays quiet", async () => {
    behaviors.set("a", { pending: true }); // the load never settles
    const controller = new AbortController();
    const pending = createViewerEngine(
      { state: makeState([{ id: "a", type: "gated" }]), views: makeViews({ main: ["a"] }) },
      { signal: controller.signal, waitUntil: "layers" },
    );

    await flushMicrotasks(); // mounted; the layer wait is in flight
    expect(rafQueue.size).toBeGreaterThan(0); // a mounted frame is pending
    controller.abort();

    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(0); // the pending frame was cancelled

    // No late render/subscription activity after abort: a layer signal on the
    // detached channel and a manual frame flush render nothing.
    instances.get("a")!.finish();
    await flushMicrotasks();
    flushRaf();
    expect(CountingView.frames).toBe(0);
  });

  test("abort after resolution has no effect — the engine is the caller's", async () => {
    const controller = new AbortController();
    const engine = track(await createViewerEngine(
      { state: makeState([]), views: makeViews({ main: [] }) },
      { signal: controller.signal, waitUntil: "layers" },
    ));
    controller.abort(); // creation already settled — no rejection, no teardown
    await flushMicrotasks();
    expect(deviceDestroy).not.toHaveBeenCalled();
    expect(engine.getViewConfig("main")).toBeDefined();
  });
});
