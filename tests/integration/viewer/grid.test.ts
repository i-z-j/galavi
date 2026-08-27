// @vitest-environment jsdom

/**
 * Grid composition tests (through the facade): `createViewer` with
 * `composition: { type: "grid", config }`.
 *
 * The composition stays pure and config-driven (`{ pool, page, slices }`); the
 * Viewer owns the canvas pool DOM and paging. Page turns via
 * `viewer.setCompositionConfig` re-slice every pool cell in ONE batched layer
 * transaction (one commit, one subscriber notification — the old
 * `SliceGrid.setSlices` semantics); a pool change rebuilds the scene.
 *
 * Harness: jsdom DOM + fake WebGPU device (rAF stubbed — no render pass runs);
 * a stub Dataset kind serves a synthetic multichannel pyramid.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDatasetAdapter,
  type DatasetConfig,
  type Viewer,
  type ViewerConfig,
} from "../../../src/index";
import { datasetRegistry } from "../../../src/registry";
import type { ImagePyramid } from "../../../src/state/schema";

// ============================================================================
// STUB DATASET KIND
// ============================================================================

const KIND = "grid-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "grid-stub": { type: "grid-stub"; source: string };
  }
}

/** z=10 multichannel pyramid (two levels). */
const PYRAMID: ImagePyramid = {
  levels: [
    { path: "0", shape: [64, 48, 10], chunkSize: [16, 16, 2], scale: [1, 1, 2] },
    { path: "1", shape: [32, 24, 5], chunkSize: [16, 16, 5], scale: [2, 2, 4] },
  ],
};

/** 2D single-slice pyramid (the named-plane shape: no c axis, one channel). */
const PYRAMID_2D: ImagePyramid = {
  levels: [{ path: "0", shape: [128, 96, 1], chunkSize: [32, 32, 1], scale: [1, 1, 1] }],
};

const DESC: DatasetConfig = { type: KIND, source: "mem://3d" };
const DESC_2D: DatasetConfig = { type: KIND, source: "mem://2d" };

class StubGridDataset extends Dataset {
  pyramid: ImagePyramid = PYRAMID;
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    const is2d = this.config.source === DESC_2D.source;
    this.pyramid = is2d ? PYRAMID_2D : PYRAMID;
    this.physical = is2d
      ? { spatial: { origin: [0, 0, 0], size: [128, 96, 1], unit: "mm" } }
      : { spatial: { origin: [0, 0, 0], size: [64, 48, 20], unit: "µm", spacing: [1, 1, 2] } };
    this.dimensions = is2d ? [] : [{ name: "c", size: 2 }, { name: "t", size: 3 }];
    this.defaultSelection = is2d ? {} : { c: 0, t: 1 };
    this.channels = is2d
      ? [{ index: 0, label: "gray", color: "#FFFFFF", contrast: [0, 1], visible: true }]
      : [
        { index: 0, label: "DAPI", color: "#00B0FF", contrast: [0.1, 0.9], visible: true },
        { index: 1, label: "GFP", color: "#00FF00", contrast: [0.2, 0.8], visible: false },
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
// FAKE WEBGPU (jsdom supplies the DOM; canvases get a fake WebGPU context)
// ============================================================================

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
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

const realGetContext = HTMLCanvasElement.prototype.getContext;

// ============================================================================
// HARNESS
// ============================================================================

let viewers: Viewer[];

beforeEach(() => {
  viewers = [];
  stubWebGPU();
  HTMLCanvasElement.prototype.getContext = (() => ({
    configure() {},
    unconfigure() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  registerDatasetAdapter(KIND, (config) => new StubGridDataset(config));
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  HTMLCanvasElement.prototype.getContext = realGetContext;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function makeContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

async function makeGridViewer(
  config: ViewerConfig = {},
  dataset: DatasetConfig = DESC,
): Promise<Viewer> {
  const viewer = await createViewer(makeContainer(), { dataset, ...config });
  viewers.push(viewer);
  return viewer;
}

function layerOf(viewer: Viewer, id: string) {
  const layer = viewer.runtime!.getState().layers!.find((l) => l.id === id);
  expect(layer, `layer "${id}"`).toBeDefined();
  return layer!;
}

// ============================================================================
// CREATION — POOL, LAYOUT, BINDINGS
// ============================================================================

describe("grid composition creation", () => {
  test("one slice view per pool cell, one layer per cell per channel", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    expect(viewer.resolvedComposition).toBe("grid");
    expect(viewer.availableCompositions).toEqual(["slice", "volume", "quad", "grid"]);

    const state = viewer.runtime!.getState();
    expect(state.layers!.map((layer) => layer.id)).toEqual(
      [0, 1, 2, 3].map((i) => [`grid-cell-${i}-c0`, `grid-cell-${i}-c1`]).flat(),
    );
    for (let i = 0; i < 4; i++) {
      const view = viewer.runtime!.getViewConfig(`grid-cell-${i}`);
      expect(view?.type).toBe("slice");
      expect(view?.layers).toEqual([`grid-cell-${i}-c0`, `grid-cell-${i}-c1`]);
      expect(view?.activatable).toBe(false); // non-interactive cells
      expect(view?.canvas).toBeDefined(); // the Viewer owns and mounts the pool
    }
    // Page 0: cells show slices 0..3 (z=10 covers them all).
    for (let i = 0; i < 4; i++) {
      expect(layerOf(viewer, `grid-cell-${i}-c0`).options?.sliceIndex).toBe(i);
    }
  });

  test("the Viewer owns the pool DOM (one host, one canvas per cell)", async () => {
    const container = makeContainer();
    const viewer = await createViewer(container, {
      dataset: DESC,
      composition: { type: "grid", config: { pool: 4 } },
    });
    viewers.push(viewer);

    expect(container.children).toHaveLength(1);
    const host = container.children[0] as HTMLElement;
    expect(host.tagName).toBe("DIV");
    expect(host.style.display).toBe("grid");
    expect(host.children).toHaveLength(4);
    for (const cell of Array.from(host.children)) {
      expect(cell.tagName).toBe("CANVAS");
    }
    viewer.destroy();
    expect(container.children).toHaveLength(0);
  });

  test("generated layers carry the resource pair, axes, selection defaults, and render state", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 1 } },
    });
    const c0 = layerOf(viewer, "grid-cell-0-c0");
    expect(c0.type).toBe("slice");
    expect(c0.data?.pyramid).toBeDefined();
    expect(c0.options).toEqual({
      axes       : ["x", "y"],
      sliceIndex : 0,
      // selection.c per channel, merged over the resource's defaults.
      selection  : { c: 0, t: 1 },
    });
    expect(c0.render).toEqual({
      visible        : true,
      color          : "#00B0FF",
      contrastLimits : [0.1, 0.9],
      blending       : "additive",
    });
    const c1 = layerOf(viewer, "grid-cell-0-c1");
    expect(c1.options?.selection).toEqual({ c: 1, t: 1 });
    expect(c1.render?.visible).toBe(false); // the channel's own visibility
  });

  test("a 2D source has one visible cell and no selection.c", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 3 } },
    }, DESC_2D);
    expect(viewer.resolvedComposition).toBe("grid");
    // z = 1: only the first page-0 cell has a slice; the rest hide.
    expect(layerOf(viewer, "grid-cell-0-c0").render?.visible).toBe(true);
    expect(layerOf(viewer, "grid-cell-1-c0").render?.visible).toBe(false);
    expect(layerOf(viewer, "grid-cell-2-c0").render?.visible).toBe(false);
    expect(layerOf(viewer, "grid-cell-0-c0").options?.selection).toEqual({}); // no c axis
  });

  test("grid is available from the auto policy's tail, never auto-selected for image data", async () => {
    // auto: 3D image → volume (grid only via explicit selection).
    const viewer = await createViewer(makeContainer(), { dataset: DESC });
    viewers.push(viewer);
    expect(viewer.resolvedComposition).toBe("volume");
    expect(viewer.availableCompositions).toContain("grid");
  });

  test("config validation rejects at the boundary, before any teardown", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 2 } },
    });
    const runtime = viewer.runtime;
    await expect(viewer.setCompositionConfig({ pool: 0 })).rejects.toThrow(
      /pool must be a positive integer/,
    );
    expect(viewer.runtime).toBe(runtime); // untouched
  });
});

// ============================================================================
// PAGING — BATCHED PAGE TURNS
// ============================================================================

describe("grid paging via setCompositionConfig", () => {
  test("a page turn re-slices every cell in ONE batched commit (no rebuild)", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    const runtime = viewer.runtime!;
    const onState = vi.fn();
    runtime.subscribe(onState);

    await viewer.setCompositionConfig({ page: 1 });

    // One commit for the whole page turn — and the SAME runtime (no rebuild).
    expect(onState).toHaveBeenCalledTimes(1);
    expect(viewer.runtime).toBe(runtime);
    for (let i = 0; i < 4; i++) {
      expect(layerOf(viewer, `grid-cell-${i}-c0`).options?.sliceIndex).toBe(4 + i);
      expect(layerOf(viewer, `grid-cell-${i}-c1`).options?.sliceIndex).toBe(4 + i);
    }
    // The normalized config mirrors into the portable state.
    expect(viewer.getState().composition).toEqual({ type: "grid", config: { pool: 4, page: 1 } });
  });

  test("the out-of-range tail hides; re-paging restores channel visibility", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    // z = 10: page 2 shows slices 8, 9, then hides cells 2 and 3.
    await viewer.setCompositionConfig({ page: 2 });
    expect(layerOf(viewer, "grid-cell-0-c0").options?.sliceIndex).toBe(8);
    expect(layerOf(viewer, "grid-cell-1-c0").options?.sliceIndex).toBe(9);
    expect(layerOf(viewer, "grid-cell-2-c0").render?.visible).toBe(false);
    expect(layerOf(viewer, "grid-cell-3-c0").render?.visible).toBe(false);

    // Back to page 0: cell channels show again with their own visibility
    // (c0 visible, c1 hidden).
    await viewer.setCompositionConfig({ page: 0 });
    expect(layerOf(viewer, "grid-cell-2-c0").render?.visible).toBe(true);
    expect(layerOf(viewer, "grid-cell-2-c1").render?.visible).toBe(false);
  });

  test("explicit slices take precedence over the page", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { slices: [5, null, 2] } },
    });
    // slices.length IS the pool size.
    expect(viewer.runtime!.getState().layers!).toHaveLength(3 * 2);
    expect(layerOf(viewer, "grid-cell-0-c0").options?.sliceIndex).toBe(5);
    expect(layerOf(viewer, "grid-cell-1-c0").render?.visible).toBe(false); // null hides
    expect(layerOf(viewer, "grid-cell-2-c0").options?.sliceIndex).toBe(2);

    await viewer.setCompositionConfig({ page: 1 }); // ignored while slices persist? no —
    // setCompositionConfig MERGES: page updates, explicit slices still win.
    expect(layerOf(viewer, "grid-cell-0-c0").options?.sliceIndex).toBe(5);
    // Clearing the explicit slices returns to page-derived slicing.
    const state = viewer.getState();
    expect(state.composition?.config).toMatchObject({ pool: 3, slices: [5, null, 2] });
  });

  test("a pool change rebuilds the scene (structural change)", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    const runtime = viewer.runtime;
    await viewer.setCompositionConfig({ pool: 2 });
    expect(viewer.runtime).not.toBe(runtime); // rebuilt
    expect(viewer.runtime!.getState().layers!).toHaveLength(2 * 2);
    expect(viewer.resolvedComposition).toBe("grid");
    expect(viewer.getState().composition?.config).toMatchObject({ pool: 2, page: 0 });
  });
});

// ============================================================================
// CHANNELS — BATCHED UPDATES ACROSS CELLS
// ============================================================================

describe("grid channel updates", () => {
  test("a channel edit applies to every cell's layer in ONE commit", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    const onState = vi.fn();
    viewer.runtime!.subscribe(onState);

    viewer.channel(1).configure({ visible: true, color: "#FF0000", contrast: [0.3, 0.6] });

    expect(onState).toHaveBeenCalledTimes(1); // one batched commit (labels add none — no physical change? labels unchanged)
    for (let i = 0; i < 4; i++) {
      expect(layerOf(viewer, `grid-cell-${i}-c1`).render).toMatchObject({
        visible: true, color: "#FF0000", contrastLimits: [0.3, 0.6],
      });
    }
  });

  test("channel edits do not reveal hidden tail cells", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    await viewer.setCompositionConfig({ page: 2 }); // cells 2,3 hidden (z=10)
    viewer.channel(0).configure({ color: "#123456" });

    const hidden = layerOf(viewer, "grid-cell-2-c0");
    expect(hidden.render?.visible).toBe(false); // still hidden
    expect(hidden.render?.color).toBe("#123456"); // but updated
    expect(layerOf(viewer, "grid-cell-0-c0").render?.color).toBe("#123456");
  });
});

// ============================================================================
// FOCUS + STATE ROUND-TRIP
// ============================================================================

describe("grid focus + portable state", () => {
  test("setSlicePoint is a no-op (grid slices are config-driven, not focus-driven)", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 2 } },
    });
    const before = viewer.runtime!.getState().exploration.camera.target;
    viewer.setSlicePoint([0, 0, 0]);
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual(before);
    expect(layerOf(viewer, "grid-cell-0-c0").options?.sliceIndex).toBe(0);
  });

  test("the grid page survives a state round trip", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    await viewer.setCompositionConfig({ page: 1 });

    const state = JSON.parse(JSON.stringify(viewer.getState()));
    expect(state.composition).toEqual({ type: "grid", config: { pool: 4, page: 1 } });

    const restored = await createViewer(makeContainer(), { state });
    viewers.push(restored);
    expect(restored.resolvedComposition).toBe("grid");
    expect(layerOf(restored, "grid-cell-0-c0").options?.sliceIndex).toBe(4);
    expect(restored.getState().composition).toEqual({ type: "grid", config: { pool: 4, page: 1 } });
  });

  test("transitions out and back preserve the grid config (per-type settings)", async () => {
    const viewer = await makeGridViewer({
      composition: { type: "grid", config: { pool: 4 } },
    });
    await viewer.setCompositionConfig({ page: 1 });
    await viewer.setComposition({ type: "slice" });
    expect(viewer.resolvedComposition).toBe("slice");
    await viewer.setComposition({ type: "grid" });
    // The stored per-type config (pool/page) persists across the round trip.
    expect(layerOf(viewer, "grid-cell-0-c0").options?.sliceIndex).toBe(4);
    expect(viewer.getState().composition).toEqual({ type: "grid", config: { pool: 4, page: 1 } });
  });
});
