/**
 * Transactional factory cleanup tests (R6).
 *
 * A rejecting factory never returns its instance, so it must not leave owned
 * resources behind:
 *
 * - `createViewer(container, { dataset })` destroys the never-returned viewer
 *   on any failed initial open — viewer-owned DOM removed from the caller's
 *   container, the engine's GPU device released, the opened dataset disposed
 *   exactly once — and rethrows the ORIGINAL error (identity + cause intact;
 *   cleanup never masks it).
 * - `createViewerEngine(config)` destroys the never-returned engine on any
 *   failed GPU init or mount.
 * - Caller-owned canvases are never touched; no unhandled rejections escape.
 *
 * Headless: fake WebGPU device + fake DOM (rAF stubbed — no render pass
 * runs). Disposal/destruction are asserted with per-instance spies.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDataset,
  type DatasetConfig,
  type DefaultLayersOptions,
} from "../src/index";
import { createViewerEngine } from "../src/advanced";
import { datasetRegistry } from "../src/registry";
import type { LayerConfig, State } from "../src/types";

// ============================================================================
// SPY DATASET KIND — per-instance dispose spies, one surface layer per view
// ============================================================================

const KIND = "cleanup-spy";

/**
 * Test kinds own an exact config in the map, like any format package (the
 * augmentation is compilation-wide; the runtime registration happens per
 * test below).
 */
declare module "galavi" {
  interface DatasetConfigMap {
    "cleanup-spy": { type: "cleanup-spy"; source: string };
  }
}

const DESC: DatasetConfig = { type: KIND, source: "mem://ok" };
const DESC_FAIL: DatasetConfig = { type: KIND, source: "mem://fail-load" };

/** Set before creation: `load()` of the next instances rejects with this. */
let failLoadWith: Error | undefined;

class SpyDataset extends Dataset {
  readonly disposeSpy = vi.fn();

  override async load(): Promise<void> {
    if (this.config.source === DESC_FAIL.source) throw failLoadWith;
    this.physical = { spatial: { size: [10, 10, 10], spacing: [1, 1, 1], origin: [0, 0, 0] } };
    this.channels = [{ index: 0, label: "s", color: "#FFFFFF", contrast: [0, 1], visible: true }];
    this.capabilities = { modes: ["slice", "volume", "quad"], defaultMode: "volume" };
  }

  override dispose(): void {
    this.disposeSpy();
  }

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    return [{
      id   : `${options.prefix}-surf`,
      type : "surface",
      data : { url: `mem://surf-${options.prefix}.obj` },
    }];
  }
}

/** Registry-made instances, for disposal assertions. */
let created: SpyDataset[];

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

type FakeElement = {
  tagName: string;
  style: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  parentNode: FakeElement | null;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  setAttribute(): void;
  hasAttribute(): boolean;
  addEventListener(): void;
  removeEventListener(): void;
  ownerDocument?: unknown;
} & Record<string, unknown>;

function makeFakeElement(tag = "div"): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    parentElement: null,
    parentNode: null,
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentElement = null;
      child.parentNode = null;
      return child;
    },
    setAttribute() {},
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

/** A canvas whose WebGPU context works (the fake device stubs the rest). */
function makeFakeCanvas(): HTMLCanvasElement {
  const el = makeFakeElement("canvas");
  el.clientWidth = 256;
  el.clientHeight = 256;
  el.width = 0;
  el.height = 0;
  el.getContext = () => ({ configure() {}, unconfigure() {} });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256 });
  return el as unknown as HTMLCanvasElement;
}

/** A canvas whose context rejects `configure` — view mount fails with `marker`. */
function makeBadCanvas(marker: Error): HTMLCanvasElement {
  const canvas = makeFakeCanvas() as unknown as FakeElement;
  canvas.getContext = () => ({
    configure() { throw marker; },
    unconfigure() {},
  });
  return canvas as unknown as HTMLCanvasElement;
}

function makeFakeContainer(): { container: HTMLElement; el: FakeElement } {
  const el = makeFakeElement("div");
  el.ownerDocument = {
    createElement: (tag: string) =>
      tag === "canvas" ? (makeFakeCanvas() as unknown as FakeElement) : makeFakeElement(tag),
  };
  return { container: el as unknown as HTMLElement, el };
}

/** Non-GPU globals every mount/destroy path touches. */
function stubCommonEnv(): void {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, STORAGE: 0x80 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x01, COPY_DST: 0x08 });
  vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

let deviceDestroy: ReturnType<typeof vi.fn>;

/** Working fake WebGPU; `deviceDestroy` spies on the device's release. */
function stubWebGPU(): void {
  deviceDestroy = vi.fn();
  const device = {
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
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  });
  stubCommonEnv();
}

/** No WebGPU at all — `navigator.gpu` is undefined. */
function stubNoWebGPU(): void {
  vi.stubGlobal("navigator", {});
  stubCommonEnv();
}

/** The adapter exists but device creation rejects with `marker`. */
function stubFailingDevice(marker: Error): void {
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({ requestDevice: async () => { throw marker; } }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  });
  stubCommonEnv();
}

/** Surface-layer fetches: ok by default, `failStatus` where configured. */
let failingFetches: Map<string, number>;

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn((input: unknown) => {
    const status = failingFetches.get(String(input));
    if (status !== undefined) {
      return Promise.resolve({ ok: false, status, text: async () => "" });
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => OBJ });
  }));
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

function makeState(): State {
  return {
    layers      : [],
    exploration : { camera: { ...CAMERA, position: [...CAMERA.position], target: [...CAMERA.target] } },
  };
}

// ============================================================================
// HARNESS
// ============================================================================

beforeEach(() => {
  created = [];
  failLoadWith = undefined;
  failingFetches = new Map();
  registerDataset(KIND, (config) => {
    const dataset = new SpyDataset(config);
    created.push(dataset);
    return dataset;
  });
  stubFetch();
});

afterEach(() => {
  datasetRegistry.unregister(KIND);
  vi.unstubAllGlobals();
});

// ============================================================================
// createViewer — failed initial open destroys the never-returned viewer
// ============================================================================

describe("createViewer transactional cleanup", () => {
  test("missing WebGPU after the container canvas was inserted: DOM removed, dataset disposed once", async () => {
    stubNoWebGPU();
    const { container, el } = makeFakeContainer();

    await expect(createViewer(container, { dataset: DESC })).rejects.toThrow("WebGPU not supported");

    expect(el.children).toHaveLength(0); // viewer-owned canvas removed
    expect(created).toHaveLength(1);
    expect(created[0]!.disposeSpy).toHaveBeenCalledTimes(1); // exactly once
  });

  test("device creation failure: original error identity, DOM removed, dataset disposed once", async () => {
    const marker = new Error("requestDevice exploded");
    stubFailingDevice(marker);
    const { container, el } = makeFakeContainer();

    await expect(createViewer(container, { dataset: DESC })).rejects.toBe(marker);

    expect(el.children).toHaveLength(0);
    expect(created[0]!.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("dataset load failure: original error and cause, no DOM ever inserted", async () => {
    stubWebGPU();
    const cause = new Error("No OME-Zarr multiscales metadata found");
    failLoadWith = Object.assign(new Error("Failed to open mem://fail-load"), { cause });
    const { container, el } = makeFakeContainer();

    await expect(createViewer(container, { dataset: DESC_FAIL })).rejects.toBe(failLoadWith);
    expect((failLoadWith as unknown as { cause?: unknown }).cause).toBe(cause);

    expect(el.children).toHaveLength(0); // open fails before any canvas is inserted
    // The failed-load instance was never adopted — nothing to dispose.
    expect(created[0]!.disposeSpy).not.toHaveBeenCalled();
  });

  test("view mount failure on a caller-owned canvas: canvas preserved, device destroyed once", async () => {
    stubWebGPU();
    const marker = new Error("configure exploded");
    const canvas = makeBadCanvas(marker);
    const { el } = makeFakeContainer();
    el.appendChild(canvas as unknown as FakeElement); // caller owns the canvas in its DOM

    await expect(createViewer(canvas, { dataset: DESC })).rejects.toBe(marker);

    expect(canvas.parentNode).toBe(el); // never owned, never removed
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
    expect(created[0]!.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("generated-layer readiness failure: DOM removed, dataset disposed once, device destroyed once", async () => {
    stubWebGPU();
    failingFetches.set("mem://surf-volume.obj", 404);
    const { container, el } = makeFakeContainer();

    await expect(createViewer(container, { dataset: DESC })).rejects.toThrow(
      "Surface fetch failed: 404",
    );

    expect(el.children).toHaveLength(0);
    expect(created[0]!.disposeSpy).toHaveBeenCalledTimes(1);
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
  });

  test("a failed creation produces no unhandled rejections", async () => {
    stubWebGPU();
    failingFetches.set("mem://surf-volume.obj", 500);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(createViewer(makeFakeContainer().container, { dataset: DESC })).rejects.toThrow(
        "Surface fetch failed: 500",
      );
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

// ============================================================================
// createViewerEngine — failed GPU init / mount destroys the engine
// ============================================================================

describe("createViewerEngine transactional cleanup", () => {
  test("missing WebGPU rejects and leaves the registry usable", async () => {
    stubNoWebGPU();
    await expect(createViewerEngine({
      state : makeState(),
      views : { main: { type: "volume", canvas: makeFakeCanvas(), layers: [] } },
    })).rejects.toThrow("WebGPU not supported");

    // A later creation against a working GPU is unaffected.
    stubWebGPU();
    const engine = await createViewerEngine({
      state : makeState(),
      views : { main: { type: "volume", canvas: makeFakeCanvas(), layers: [] } },
    });
    expect(engine).toBeDefined();
    engine.destroy();
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
  });

  test("device creation failure rethrows the original error", async () => {
    const marker = new Error("requestDevice exploded");
    stubFailingDevice(marker);
    await expect(createViewerEngine({
      state : makeState(),
      views : { main: { type: "volume", canvas: makeFakeCanvas(), layers: [] } },
    })).rejects.toBe(marker);
  });

  test("first view mount failure: original error, device destroyed once", async () => {
    stubWebGPU();
    const marker = new Error("configure exploded");
    await expect(createViewerEngine({
      state : makeState(),
      views : {
        first  : { type: "volume", canvas: makeBadCanvas(marker), layers: [] },
        second : { type: "volume", canvas: makeFakeCanvas(), layers: [] },
      },
    })).rejects.toBe(marker);
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
  });

  test("second view mount failure: first view's resize observer detached, device destroyed once", async () => {
    stubWebGPU();
    const observers: { disconnected: boolean }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      instance = { disconnected: false };
      constructor(_callback: ResizeObserverCallback) { observers.push(this.instance); }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void { this.instance.disconnected = true; }
    });
    const marker = new Error("configure exploded");
    await expect(createViewerEngine({
      state : makeState(),
      views : {
        first  : { type: "volume", canvas: makeFakeCanvas(), layers: [] },
        second : { type: "volume", canvas: makeBadCanvas(marker), layers: [] },
      },
    })).rejects.toBe(marker);

    expect(observers).toHaveLength(1); // the first view mounted and observed
    expect(observers[0]!.disconnected).toBe(true); // …and was detached on teardown
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
  });
});
