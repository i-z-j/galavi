/**
 * Shared headless harness for the high-level Viewer integration tests
 * (creation / composition-switching / channels / controls-tools).
 *
 * A stub Dataset kind (`registerDatasetAdapter`) serves synthetic pyramids; a
 * minimal fake WebGPU device + fake canvas let `createViewerRuntime` mount real
 * Volume/Slice views without a GPU (rAF is stubbed, so no render pass ever
 * runs — these tests exercise config translation, state, and lifecycle, not
 * pixels).
 *
 * Each test file calls `setupViewerHarness()` at module scope to register the
 * per-test registration/teardown hooks.
 */
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDatasetAdapter,
  type DatasetConfig,
  type Viewer,
  type ViewerCompositionOverride,
  type ViewerConfig,
} from "../../../src/index";
import { datasetRegistry } from "../../../src/registry";
import type { ImagePyramid } from "../../../src/state/schema";

// ============================================================================
// STUB DATASET KIND
// ============================================================================

export const KIND = "viewer-stub";

/**
 * Test kinds own an exact config in the map, like any format package (the
 * augmentation is compilation-wide; the runtime registration happens per
 * test below). The custom resource kind drives the no-supported-composition
 * path: reference compositions only claim kinds they understand.
 */
declare module "galavi" {
  interface DatasetConfigMap {
    "viewer-stub": { type: "viewer-stub"; source: string };
  }
  interface DatasetResourceMap {
    "viewer-stub-custom": { id: string; kind: "viewer-stub-custom" };
  }
}

const PYRAMID_3D: ImagePyramid = {
  levels: [
    { path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [0.5, 0.5, 2] },
    { path: "1", shape: [4, 4, 2], chunkSize: [4, 4, 2], scale: [1, 1, 4] },
  ],
};

const PYRAMID_2D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 1], chunkSize: [4, 4, 1], scale: [1, 1, 1] }],
};

/** z-chunk=1 with more slabs than the preview budget. */
const PYRAMID_STRIDED: ImagePyramid = {
  levels: [{ path: "0", shape: [256, 256, 500], chunkSize: [256, 256, 1], scale: [1, 1, 1] }],
};

export const DESC_3D: DatasetConfig = { type: KIND, source: "mem://3d" };
export const DESC_2D: DatasetConfig = { type: KIND, source: "mem://2d" };
export const DESC_STRIDED: DatasetConfig = { type: KIND, source: "mem://strided" };
export const DESC_ALL_ACTIVE: DatasetConfig = { type: KIND, source: "mem://all-active" };
export const DESC_OTHER: DatasetConfig = { type: KIND, source: "mem://other" };
export const DESC_FAIL: DatasetConfig = { type: KIND, source: "mem://fail" };
/** A dataset whose only resource is a kind no reference composition understands. */
export const DESC_UNSUPPORTED: DatasetConfig = { type: KIND, source: "mem://unsupported" };

/**
 * Stub image dataset: reproduces the image-kind behavior these tests assert
 * on — fixed channels/physical/dimensions/defaultSelection per fixture URL,
 * exposed through one primary `"image-pyramid"` resource.
 */
class StubPyramidDataset extends Dataset {
  pyramid: ImagePyramid = PYRAMID_3D;
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    const source = this.config.source;
    if (source === DESC_FAIL.source) {
      const cause = new Error("No OME-Zarr multiscales metadata found");
      throw Object.assign(new Error(`Failed to open ${source}`), { cause });
    }
    if (source === DESC_UNSUPPORTED.source) {
      this.resources = [{ id: "weird", kind: "viewer-stub-custom" }];
      this.primaryResourceId = "weird";
      return;
    }
    this.pyramid =
      source === DESC_2D.source ? PYRAMID_2D :
      source === DESC_STRIDED.source ? PYRAMID_STRIDED :
      PYRAMID_3D;
    const allActive = source === DESC_ALL_ACTIVE.source;
    this.physical = { spatial: { size: [4, 4, 8], unit: "μm", spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } };
    this.dimensions = [{ name: "c", size: 2, labels: ["a", "b"] }];
    this.defaultSelection = { c: 0 };
    this.channels = [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: allActive },
    ];
    this.resources = [{
      id: "image",
      kind: "image-pyramid",
      pyramid: this.pyramid,
      fetch: this.fetch,
      physical: this.physical,
      dimensions: this.dimensions,
      defaultSelection: this.defaultSelection,
      channels: this.channels,
    }];
    this.primaryResourceId = "image";
  }

  override dispose(): void {}
}

// ============================================================================
// FAKE DOM + WEBGPU
// ============================================================================

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

export function makeFakeCanvas(): HTMLCanvasElement {
  const el = makeFakeElement("canvas");
  el.clientWidth = 256;
  el.clientHeight = 256;
  el.width = 0;
  el.height = 0;
  el.getContext = () => ({ configure() {}, unconfigure() {} });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256 });
  return el as unknown as HTMLCanvasElement;
}

export function makeFakeContainer(): { container: HTMLElement; el: FakeElement } {
  const el = makeFakeElement("div");
  const doc = {
    createElement: (tag: string) =>
      tag === "canvas" ? (makeFakeCanvas() as unknown as FakeElement) : makeFakeElement(tag),
  };
  el.ownerDocument = doc;
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
// HARNESS
// ============================================================================

let viewers: Viewer[] = [];

/**
 * Registers the per-test hooks: stub WebGPU globals + the stub dataset kind
 * before each test; destroy created viewers + unregister after each.
 */
export function setupViewerHarness(): void {
  beforeEach(() => {
    viewers = [];
    stubWebGPU();
    registerDatasetAdapter(KIND, (config) => new StubPyramidDataset(config));
  });

  afterEach(() => {
    for (const viewer of viewers.splice(0)) viewer.destroy();
    datasetRegistry.unregister(KIND);
    vi.unstubAllGlobals();
  });
}

export async function makeViewer(
  element: string | HTMLElement | HTMLCanvasElement = makeFakeCanvas(),
  config: ViewerConfig = {},
): Promise<Viewer> {
  const viewer = await createViewer(element, config);
  viewers.push(viewer);
  return viewer;
}

export function layerOf(viewer: Viewer, id: string) {
  const layer = viewer.runtime!.getState().layers!.find((l) => l.id === id);
  expect(layer, `layer "${id}"`).toBeDefined();
  return layer!;
}

/** The per-composition override section of the portable state, typed for assertions. */
export function compositionOverridesOf(
  viewer: Viewer,
): Record<string, ViewerCompositionOverride> | undefined {
  return viewer.getState().compositions as Record<string, ViewerCompositionOverride> | undefined;
}

export function overlayKeys(viewer: Viewer, viewId = "main"): string[] {
  return Object.keys(viewer.runtime!.getViewConfig(viewId)?.overlays ?? {});
}

export function liveOverlays(viewer: Viewer, viewId = "main"): readonly unknown[] {
  return viewer.runtime!.view(viewId).base.getOverlays();
}

export function controlTypes(viewer: Viewer, viewId = "main"): string[] {
  return viewer.runtime!.view(viewId).base.getControls().map(
    (c) => (c.constructor as unknown as { controlType: string }).controlType,
  );
}
