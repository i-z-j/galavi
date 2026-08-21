/**
 * Zero-size host diagnostic tests (R9).
 *
 * A host element with zero layout area produces a 1×1-clamped canvas backing
 * store and a viewer that still reports ready — silently invisible. After the
 * initial mount settles (the resize observer's first delivery when one is
 * active, else a short settle window), the view warns ONCE, naming the view,
 * the measured box, and the likely causes. The 1×1 clamp stays the runtime
 * behavior; there is no hard error.
 *
 * Headless: fake WebGPU device + fake DOM (rAF stubbed — no render pass
 * runs); the settle window is driven with fake timers.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDataset,
  type DatasetConfig,
  type DefaultLayersOptions,
  type Viewer,
} from "../src/index";
import type { ViewerEngine } from "../src/viewer";
import { BaseView } from "../src/view";
import { datasetRegistry } from "../src/registry";
import type { ImagePyramid, LayerConfig, State } from "../src/types";

// ============================================================================
// STUB DATASET KIND — minimal 2D image dataset
// ============================================================================

const KIND = "zero-size-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "zero-size-stub": { type: "zero-size-stub"; source: string };
  }
}

const PYRAMID_2D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 1], chunkSize: [4, 4, 1], scale: [1, 1, 1] }],
};

const DESC: DatasetConfig = { type: KIND, source: "mem://2d" };

class StubImageDataset extends Dataset {
  override async load(): Promise<void> {
    this.physical = { spatial: { size: [8, 8, 1], spacing: [1, 1, 1], origin: [0, 0, 0] } };
    this.channels = [{ index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true }];
    this.capabilities = { modes: ["slice"], defaultMode: "slice" };
  }

  override dispose(): void {}

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    return [{
      id      : `${options.prefix}-c0`,
      type    : options.view,
      data    : { pyramid: PYRAMID_2D, fetch: async () => new ArrayBuffer(0) },
      options : { selection: { c: 0 } },
    }];
  }
}

// ============================================================================
// FAKE DOM + WEBGPU — parameterized canvas sizes
// ============================================================================

let canvasClientWidth = 256;
let canvasClientHeight = 256;

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

function makeFakeCanvas(): HTMLCanvasElement {
  const el = makeFakeElement("canvas");
  Object.defineProperties(el, {
    clientWidth  : { get: () => canvasClientWidth, configurable: true },
    clientHeight : { get: () => canvasClientHeight, configurable: true },
  });
  el.width = 0;
  el.height = 0;
  el.getContext = () => ({ configure() {}, unconfigure() {} });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256 });
  return el as unknown as HTMLCanvasElement;
}

function makeFakeContainer(): { container: HTMLElement; el: FakeElement } {
  const el = makeFakeElement("div");
  el.ownerDocument = {
    createElement: (tag: string) =>
      tag === "canvas" ? (makeFakeCanvas() as unknown as FakeElement) : makeFakeElement(tag),
  };
  return { container: el as unknown as HTMLElement, el };
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

// ============================================================================
// HARNESS — viewer level (no ResizeObserver here: the settle-window path)
// ============================================================================

let viewers: Viewer[];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  viewers = [];
  canvasClientWidth = 256;
  canvasClientHeight = 256;
  stubWebGPU();
  registerDataset(KIND, (config) => new StubImageDataset(config));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Only the diagnostic's settle timer is faked — rAF stays stubbed (no
  // render pass runs) and promise microtasks are unaffected.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  warnSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("zero-size host diagnostic (settle-window path)", () => {
  test("a zero-area host warns once, naming view/box/causes, and the viewer still becomes ready", async () => {
    canvasClientWidth = 0;
    canvasClientHeight = 0;
    const { container } = makeFakeContainer();
    const viewer = await createViewer(container, { dataset: DESC });
    viewers.push(viewer);

    expect(viewer.status).toBe("ready"); // no hard error — the 1×1 clamp holds
    expect(warnSpy).not.toHaveBeenCalled(); // not before layout settles

    vi.advanceTimersByTime(100);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]![0]);
    expect(message).toContain('view "main"');
    expect(message).toContain("0×0");
    expect(message).toContain("display: none");
    expect(message).toContain("CSS");

    vi.advanceTimersByTime(1000); // still exactly once — never per frame/resize
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("a nonzero host stays silent", async () => {
    const { container } = makeFakeContainer();
    const viewer = await createViewer(container, { dataset: DESC });
    viewers.push(viewer);
    expect(viewer.status).toBe("ready");

    vi.advanceTimersByTime(1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("destroy before the settle window cancels the diagnostic", async () => {
    canvasClientWidth = 0;
    canvasClientHeight = 0;
    const { container } = makeFakeContainer();
    const viewer = await createViewer(container, { dataset: DESC });
    viewer.destroy();

    vi.advanceTimersByTime(1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// VIEW LEVEL — the ResizeObserver first-delivery path
// ============================================================================

class TestView extends BaseView {
  static readonly viewType = "zero-size-test";
  protected async initGPUResources(): Promise<void> {}
  protected override onLayersChanged(): void {}
  protected renderFrame(_state: State): void {}
}

type ObserverInstance = {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
};

function stubResizeObserver(): ObserverInstance[] {
  const observers: ObserverInstance[] = [];
  vi.stubGlobal("ResizeObserver", class {
    callback: ResizeObserverCallback;
    instance: ObserverInstance;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      this.instance = { callback, observed: [], disconnected: false };
      observers.push(this.instance);
    }
    observe(target: Element) { this.instance.observed.push(target); }
    unobserve(target: Element) {
      this.instance.observed = this.instance.observed.filter((t) => t !== target);
    }
    disconnect() { this.instance.disconnected = true; }
  });
  return observers;
}

describe("zero-size host diagnostic (ResizeObserver first delivery)", () => {
  test("a zero-area canvas warns once on the first delivery, without a settle timer", async () => {
    canvasClientWidth = 0;
    canvasClientHeight = 0;
    const observers = stubResizeObserver();

    const view = new TestView("v1");
    view.setOwner({ requestRender: () => {} } as unknown as ViewerEngine);
    view.setDevice({} as GPUDevice);
    const canvas = makeFakeCanvas();
    await view.mount(canvas);

    expect(observers).toHaveLength(1); // the one resize observer, reused
    expect(warnSpy).not.toHaveBeenCalled();

    observers[0]!.callback([], {} as ResizeObserver); // first delivery
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('view "v1"');

    observers[0]!.callback([], {} as ResizeObserver); // later deliveries stay silent
    expect(warnSpy).toHaveBeenCalledTimes(1);

    view.destroy();
  });

  test("a nonzero canvas never warns on delivery", async () => {
    const observers = stubResizeObserver();
    const view = new TestView("v2");
    view.setOwner({ requestRender: () => {} } as unknown as ViewerEngine);
    view.setDevice({} as GPUDevice);
    await view.mount(makeFakeCanvas());

    observers[0]!.callback([], {} as ResizeObserver);
    vi.advanceTimersByTime(1000);
    expect(warnSpy).not.toHaveBeenCalled();

    view.destroy();
  });
});
