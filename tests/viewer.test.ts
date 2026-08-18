/**
 * High-level Viewer contract tests (DX-L1/L2/M3/M6).
 *
 * Verifies the §15.5 translation to the low-level scene model headless: a
 * stub Dataset kind (`registerDataset`) serves synthetic pyramids; a minimal
 * fake WebGPU device + fake canvas let `createViewerEngine` mount real
 * Volume/Slice views without a GPU (rAF is stubbed, so no render pass ever
 * runs — these tests exercise config translation, state, and lifecycle, not
 * pixels).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  MeshDataset,
  ViewerEngine,
  getDatasetCapabilities,
  registerDataset,
  ViewerSupersededError,
  type DatasetConfig,
  type DefaultLayersOptions,
  type Viewer,
  type ViewerConfig,
} from "../src/advanced";
import { datasetRegistry } from "../src/registry";
import type { ImagePyramid, LayerConfig } from "../src/types";

// ============================================================================
// STUB DATASET KIND
// ============================================================================

const KIND = "viewer-stub";

/**
 * Test kinds own an exact config in the map, like any format package (the
 * augmentation is compilation-wide; the runtime registration happens per
 * test below).
 */
declare module "galavi" {
  interface DatasetConfigMap {
    "viewer-stub": { type: "viewer-stub"; source: string };
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

/** z-chunk=1 with more slabs than the preview budget — the DX-M4 pathology. */
const PYRAMID_STRIDED: ImagePyramid = {
  levels: [{ path: "0", shape: [256, 256, 500], chunkSize: [256, 256, 1], scale: [1, 1, 1] }],
};

const DESC_3D: DatasetConfig = { type: KIND, source: "mem://3d" };
const DESC_2D: DatasetConfig = { type: KIND, source: "mem://2d" };
const DESC_STRIDED: DatasetConfig = { type: KIND, source: "mem://strided" };
const DESC_ALL_ACTIVE: DatasetConfig = { type: KIND, source: "mem://all-active" };
const DESC_OTHER: DatasetConfig = { type: KIND, source: "mem://other" };
const DESC_FAIL: DatasetConfig = { type: KIND, source: "mem://fail" };
/** 3D pyramid with a synthetic slice-only presentation restriction. */
const DESC_RESTRICTED: DatasetConfig = { type: KIND, source: "mem://restricted" };

/**
 * Stub image dataset: reproduces the image-kind behavior these tests assert
 * on — fixed channels/physical/dimensions/defaultSelection per fixture URL,
 * capability-driven auto mode, and per-channel typed layers.
 */
class StubImageDataset extends Dataset {
  pyramid: ImagePyramid = PYRAMID_3D;
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    const source = this.config.source;
    if (source === DESC_FAIL.source) {
      const cause = new Error("No OME-Zarr multiscales metadata found");
      throw Object.assign(new Error(`Failed to open ${source}`), { cause });
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
    // The restricted fixture declares a slice-only presentation even though
    // its pyramid is 3D — a synthetic restricted dataset.
    this.capabilities = source === DESC_RESTRICTED.source
      ? { modes: ["slice"], defaultMode: "slice" }
      : getDatasetCapabilities(this.pyramid);
  }

  override dispose(): void {}

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    const { view, prefix, axes, channels, projection, transform } = options;
    return channels.map((channel) => ({
      id   : `${prefix}-c${channel.index}`,
      type : view,
      data : {
        pyramid : this.pyramid,
        fetch   : this.fetch,
        ...(transform !== undefined ? { transform: [...transform] } : {}),
      },
      render: {
        visible        : channel.visible,
        color          : channel.color,
        contrastLimits : [...channel.contrast] as [number, number],
        // One layer per channel composites fluorescence-style: additive is
        // the multichannel default for viewer-generated image layers.
        blending       : "additive",
        ...(view === "volume" ? { volumeProjection: projection } : {}),
      },
      options: {
        ...(axes ? { axes: [...axes] } : {}),
        selection: { ...this.defaultSelection, c: channel.index },
      },
    }));
  }
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

function makeFakeContainer(): { container: HTMLElement; el: FakeElement } {
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

let viewers: Viewer[];

beforeEach(() => {
  viewers = [];
  stubWebGPU();
  registerDataset(KIND, (config) => new StubImageDataset(config));
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  vi.unstubAllGlobals();
});

async function makeViewer(
  element: string | HTMLElement | HTMLCanvasElement = makeFakeCanvas(),
  config: ViewerConfig = {},
): Promise<Viewer> {
  const viewer = await createViewer(element, config);
  viewers.push(viewer);
  return viewer;
}

function layerOf(viewer: Viewer, id: string) {
  const layer = viewer.engine!.getState().layers.find((l) => l.id === id);
  expect(layer, `layer "${id}"`).toBeDefined();
  return layer!;
}

function overlayKeys(viewer: Viewer, viewId = "main"): string[] {
  return Object.keys(viewer.engine!.getViewConfig(viewId)?.overlays ?? {});
}

function liveOverlays(viewer: Viewer, viewId = "main"): readonly unknown[] {
  return viewer.engine!.view(viewId).base.getOverlays();
}

function controlTypes(viewer: Viewer, viewId = "main"): string[] {
  return viewer.engine!.view(viewId).base.getControls().map(
    (c) => (c.constructor as unknown as { controlType: string }).controlType,
  );
}

// ============================================================================
// TARGET RESOLUTION
// ============================================================================

describe("createViewer target resolution", () => {
  test("rejects for an unmatched selector", async () => {
    vi.stubGlobal("document", { querySelector: () => null });
    await expect(createViewer("#nope")).rejects.toThrow(/no element matches selector "#nope"/);
  });

  test("a container gets a viewer-owned canvas; destroy removes it", async () => {
    const { container, el } = makeFakeContainer();
    const viewer = await makeViewer(container);
    expect(viewer.status).toBe("idle");

    await viewer.open(DESC_3D);
    expect(el.children).toHaveLength(1);
    const canvas = el.children[0];
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.style.width).toBe("100%");
    expect(viewer.canvas).toBe(canvas);

    viewer.destroy();
    expect(el.children).toHaveLength(0);
  });

  test("a selector resolves through document.querySelector", async () => {
    const { container } = makeFakeContainer();
    vi.stubGlobal("document", { querySelector: (sel: string) => (sel === "#app" ? container : null) });
    const viewer = await makeViewer("#app");
    expect(viewer.status).toBe("idle");
  });

  test("a passed canvas is used directly and survives destroy", async () => {
    const canvas = makeFakeCanvas();
    const viewer = await makeViewer(canvas, { dataset: DESC_3D });
    expect(viewer.canvas).toBe(canvas);
    viewer.destroy();
    expect(canvas.parentNode).toBeNull(); // never owned, never removed
  });
});

// ============================================================================
// OPEN + TRANSLATION (§15.5)
// ============================================================================

describe("open translation to the low-level scene model", () => {
  test("3D dataset in auto mode → volume view, one typed layer per channel", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    const engine = viewer.engine!;
    expect(engine).toBeInstanceOf(ViewerEngine);
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedMode).toBe("volume");
    // Canvas target: the dataset's modes minus quad (it needs a container).
    expect(viewer.availableModes).toEqual(["slice", "volume"]);
    expect(viewer.dataset?.config).toEqual(DESC_3D);

    const state = engine.getState();
    // Physical comes from the resolved dataset, with channel names promoted.
    expect(state.physical?.spatial.size).toEqual([4, 4, 8]);
    expect(state.physical?.spatial.unit).toBe("μm");
    expect(state.physical?.channels?.names).toEqual(["a", "b"]);

    // One typed volume layer per channel, nested options.selection.c.
    expect(state.layers.map((l) => l.id)).toEqual(["volume-c0", "volume-c1"]);
    for (const [i, layer] of state.layers.entries()) {
      expect(layer.type).toBe("volume");
      expect(layer.options?.selection).toEqual({ c: i });
      expect(layer.options).not.toHaveProperty("maxPoolSize"); // DX-M4 policy owns budgets
      expect(layer.render?.volumeProjection).toBe("mip");
    }
    // Channel visibility defaults come from the dataset (active flags respected).
    expect(state.layers[0].render).toMatchObject({ visible: true, color: "#00B0FF", contrastLimits: [0, 1] });
    expect(state.layers[1].render).toMatchObject({ visible: false, color: "#FF3D3D" });

    // The view binds the canvas, the layer ids, and the mode-default control.
    const view = engine.getViewConfig("main")!;
    expect(view.type).toBe("volume");
    expect(view.layers).toEqual(["volume-c0", "volume-c1"]);
    expect(view.controls).toEqual({ orbit: {} });
    expect(view.overlays).toEqual({});

    // Fit camera frames the dataset bounds (center of the physical box).
    expect(engine.getState().exploration.camera.target).toEqual([2, 2, 4]);
  });

  test("2D dataset in auto mode → slice view and slice layers", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_2D });
    expect(viewer.resolvedMode).toBe("slice");
    expect(viewer.availableModes).toEqual(["slice"]);

    const state = viewer.engine!.getState();
    expect(state.layers.map((l) => l.id)).toEqual(["slice-c0", "slice-c1"]);
    expect(state.layers[0].type).toBe("slice");
    expect(state.layers[0].options?.selection).toEqual({ c: 0 });
    expect(state.layers[0].render?.volumeProjection).toBeUndefined();

    const view = viewer.engine!.getViewConfig("main")!;
    expect(view.type).toBe("slice");
    expect(view.controls).toEqual({ panzoom: {} });

    const camera = state.exploration.camera;
    expect(camera.navMode).toBe("fly");
    expect(camera.projMode).toBe("orthographic");
    expect(camera.target).toEqual([2, 2, 4]);
  });

  test("z-chunk=1 pyramid in auto mode → volume via the bounded-preview capability", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_STRIDED });
    expect(viewer.dataset?.capabilities).toMatchObject({
      modes: ["slice", "volume", "quad"],
      defaultMode: "volume",
    });
    expect(viewer.resolvedMode).toBe("volume");
    const layer = layerOf(viewer, "volume-c0");
    expect(layer.options).not.toHaveProperty("maxPoolSize");
  });

  test("explicit mode wins over auto resolution", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, mode: "slice" });
    expect(viewer.resolvedMode).toBe("slice");
    expect(viewer.engine!.getViewConfig("main")?.type).toBe("slice");
    expect(layerOf(viewer, "slice-c0").type).toBe("slice");
  });

  test("OMERO-active-style all-visible channels are respected", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_ALL_ACTIVE });
    expect(layerOf(viewer, "volume-c0").render?.visible).toBe(true);
    expect(layerOf(viewer, "volume-c1").render?.visible).toBe(true);
  });
});

// ============================================================================
// OPEN STATUS / FAILURE / SUPERSESSION (DX-M2)
// ============================================================================

describe("open status semantics", () => {
  test("status transitions idle → loading → ready", async () => {
    const viewer = await makeViewer();
    expect(viewer.status).toBe("idle");
    const pending = viewer.open(DESC_3D);
    expect(viewer.status).toBe("loading");
    await pending;
    expect(viewer.status).toBe("ready");
    expect(viewer.error).toBeUndefined();
  });

  test("open rejects with the load error and its cause; status → error", async () => {
    const viewer = await makeViewer();
    let rejection: unknown;
    try {
      await viewer.open(DESC_FAIL);
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Failed to open mem://fail");
    expect((rejection as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((rejection as Error & { cause: Error }).cause).message).toBe("No OME-Zarr multiscales metadata found");
    expect(viewer.status).toBe("error");
    expect(viewer.error).toBe(rejection);
    await expect(viewer.ready).rejects.toBe(rejection);
  });

  test("unknown dataset kind rejects with the actionable registry error", async () => {
    const viewer = await makeViewer();
    await expect(
      // @ts-expect-error — "nope" is not a registered loader key
      viewer.open({ type: "nope", source: "mem://x" }),
    ).rejects.toThrow(
      /Unknown dataset kind: "nope"/,
    );
    expect(viewer.status).toBe("error");
  });

  test("replacing a dataset is one awaited call; superseded opens never clobber", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    const stale = viewer.open(DESC_2D);
    const fresh = viewer.open(DESC_OTHER); // 3D pyramid, distinct physical? same stub physical
    await expect(stale).rejects.toBeInstanceOf(ViewerSupersededError);
    await fresh;
    expect(viewer.status).toBe("ready");
    expect(viewer.dataset?.config.source).toBe("mem://other");
    // The fresher open won: volume mode (3D), not the superseded 2D slice.
    expect(viewer.resolvedMode).toBe("volume");
    expect(viewer.engine!.getViewConfig("main")?.type).toBe("volume");
  });

  test("a failed open leaves the previous dataset intact and can be retried", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    await expect(viewer.open(DESC_FAIL)).rejects.toThrow(/Failed to open/);
    expect(viewer.status).toBe("error");
    // Retry with a good source recovers.
    await viewer.open(DESC_OTHER);
    expect(viewer.status).toBe("ready");
    expect(viewer.dataset?.config.source).toBe("mem://other");
  });
});

// ============================================================================
// CHANNELS (DX-M3) + DECLARATIVE/IMPERATIVE PARITY (§15.4)
// ============================================================================

describe("channel model", () => {
  test("config channels and channel().configure produce identical layers", async () => {
    const patch = { visible: true, color: "ff0000", contrast: [0.2, 0.8] as [number, number] };
    const declarative = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      channels: [{ index: 1, ...patch }],
    });
    const imperative = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    imperative.channel(1).configure(patch);

    const a = layerOf(declarative, "volume-c1");
    const b = layerOf(imperative, "volume-c1");
    expect(b.render).toEqual(a.render);
    expect(b.options).toEqual(a.options);
    // Shared normalization: the color normalized to #RRGGBB on both paths.
    expect(a.render?.color).toBe("#FF0000");
    expect(a.render?.contrastLimits).toEqual([0.2, 0.8]);
  });

  test("channel().configure maps to every internal layer for that channel", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.channel(1).configure({ visible: true, contrast: [0.1, 0.4] });
    expect(layerOf(viewer, "volume-c1").render).toMatchObject({ visible: true, contrastLimits: [0.1, 0.4] });

    // Channel intent survives the mode transition onto the new slice layers.
    viewer.mode = "slice";
    await viewer.ready;
    expect(layerOf(viewer, "slice-c1").render).toMatchObject({ visible: true, contrastLimits: [0.1, 0.4] });
    expect(layerOf(viewer, "slice-c0").render).toMatchObject({ visible: true, contrastLimits: [0, 1] });
  });

  test("channel().config and viewer.channels expose the effective state", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.channel(0).configure({ label: "DAPI" });
    expect(viewer.channel(0).config).toEqual({
      index: 0, label: "DAPI", visible: true, color: "#00B0FF", contrast: [0, 1],
    });
    expect(viewer.channels.map((c) => c.label)).toEqual(["DAPI", "b"]);
    // Labels reach the shared physical channel names.
    expect(viewer.engine!.getState().physical?.channels?.names).toEqual(["DAPI", "b"]);
  });

  test("channel().configure wins over the active mode override (edit what you see)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      mode: "slice",
      modeOverrides: { slice: { channels: [{ index: 0, contrast: [0, 0.05] }] } },
    });
    expect(viewer.channel(0).config.contrast).toEqual([0, 0.05]);
    viewer.channel(0).configure({ contrast: [0.1, 0.2] });
    // The live edit is not masked by the mode override…
    expect(viewer.channel(0).config.contrast).toEqual([0.1, 0.2]);
    expect(layerOf(viewer, "slice-c0").render).toMatchObject({ contrastLimits: [0.1, 0.2] });
    // …and viewer.config mirrors it in the active mode's override.
    expect(viewer.config.modeOverrides?.slice?.channels?.[0]?.contrast).toEqual([0.1, 0.2]);
  });

  test("channel index validation is actionable", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(() => viewer.channel(2)).toThrow(/index out of range.*2 channel/);
    expect(() => viewer.channel(0).configure({ color: "red" })).toThrow(/invalid color "red"/);
    const idle = await makeViewer();
    expect(() => idle.channel(0)).toThrow(/no dataset open/);
  });
});

// ============================================================================
// PROJECTION (DX-Q5)
// ============================================================================

describe("projection", () => {
  test("config projection maps to volume layer render.volumeProjection", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, projection: "minip" });
    expect(layerOf(viewer, "volume-c0").render?.volumeProjection).toBe("minip");
    expect(layerOf(viewer, "volume-c1").render?.volumeProjection).toBe("minip");
  });

  test("imperative projection updates live volume layers and survives rebuilds", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.projection = "mean";
    expect(layerOf(viewer, "volume-c0").render?.volumeProjection).toBe("mean");
    viewer.mode = "slice";
    await viewer.ready;
    expect(layerOf(viewer, "slice-c0").render?.volumeProjection).toBeUndefined();
    viewer.mode = "volume";
    await viewer.ready;
    expect(layerOf(viewer, "volume-c0").render?.volumeProjection).toBe("mean");
    expect(() => { viewer.projection = "bogus" as never; }).toThrow(/Invalid projection/);
  });
});

// ============================================================================
// MODE TRANSITIONS (DX-L2)
// ============================================================================

describe("mode transitions", () => {
  test("slice ↔ volume preserves the physical focus", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // auto → volume
    viewer.engine!.setTarget([1, 2, 3]);

    viewer.mode = "slice";
    await viewer.ready;
    expect(viewer.resolvedMode).toBe("slice");
    expect(viewer.engine!.getViewConfig("main")?.type).toBe("slice");
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([1, 2, 3]);

    viewer.mode = "volume";
    await viewer.ready;
    expect(viewer.resolvedMode).toBe("volume");
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([1, 2, 3]);
  });

  test("rapid flips are last-write-wins and settle on the final mode", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // volume
    viewer.mode = "slice";
    viewer.mode = "volume";
    viewer.mode = "slice";
    await viewer.ready;
    expect(viewer.resolvedMode).toBe("slice");
    expect(viewer.status).toBe("ready");
    expect(viewer.engine!.getViewConfig("main")?.type).toBe("slice");
    expect(layerOf(viewer, "slice-c0").type).toBe("slice");
  });

  test("mode set before open is applied at open", async () => {
    const viewer = await makeViewer();
    viewer.mode = "slice";
    await viewer.open(DESC_3D);
    expect(viewer.resolvedMode).toBe("slice");
  });

  test("an invalid mode throws synchronously", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(() => { viewer.mode = "grid" as never; }).toThrow(/Invalid viewer mode/);
  });
});

// ============================================================================
// MODE CAPABILITIES (dataset modes ∩ target support)
// ============================================================================

describe("mode capabilities", () => {
  const OBJ = [
    "# tetrahedron",
    "v 0 0 0",
    "v 10 0 0",
    "v 0 20 0",
    "v 0 0 30",
    "f 1 2 3",
    "f 1 2 4",
    "f 1 3 4",
    "f 2 3 4",
    "",
  ].join("\n");

  test('`mode: "auto"` resolves to capabilities.defaultMode exactly', async () => {
    // 3D pyramid, but the dataset declares a slice-only presentation — auto
    // must not second-guess it with pyramid facts.
    const restricted = await makeViewer(makeFakeCanvas(), { dataset: DESC_RESTRICTED });
    expect(restricted.dataset?.capabilities).toEqual({ modes: ["slice"], defaultMode: "slice" });
    expect(restricted.resolvedMode).toBe("slice");
    expect(restricted.availableModes).toEqual(["slice"]);

    // 2D/3D image defaults (covered end-to-end above): slice / volume.
    const image2d = await makeViewer(makeFakeCanvas(), { dataset: DESC_2D });
    expect(image2d.resolvedMode).toBe("slice");
    const image3d = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(image3d.resolvedMode).toBe("volume");
  });

  test("an unsupported explicit mode rejects the open with an actionable error", async () => {
    await expect(makeViewer(makeFakeCanvas(), { dataset: DESC_2D, mode: "volume" })).rejects.toThrow(
      /Mode "volume" is not supported by dataset kind "viewer-stub" \(available: slice\)/,
    );
  });

  test("assigning an unsupported mode throws before any teardown", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_2D });
    expect(viewer.resolvedMode).toBe("slice");
    const engine = viewer.engine;

    expect(() => { viewer.mode = "volume"; }).toThrow(
      /Mode "volume" is not supported by dataset kind "viewer-stub" \(available: slice\)/,
    );
    // The rejected assignment left the running scene (and the recorded mode
    // intent) untouched.
    expect(viewer.engine).toBe(engine);
    expect(viewer.resolvedMode).toBe("slice");
    expect(viewer.mode).toBe("auto");
    expect(viewer.status).toBe("ready");
    await viewer.ready;
  });

  test("a canvas target excludes quad from the available modes", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(viewer.availableModes).toEqual(["slice", "volume"]);

    const engine = viewer.engine;
    expect(() => { viewer.mode = "quad"; }).toThrow(/quad.*requires a container element/);
    expect(viewer.engine).toBe(engine);
    expect(viewer.resolvedMode).toBe("volume");
    expect(viewer.status).toBe("ready");
  });

  test("a container target intersects to all of a 3D dataset's modes", async () => {
    const { container } = makeFakeContainer();
    const viewer = await makeViewer(container, { dataset: DESC_3D });
    expect(viewer.availableModes).toEqual(["slice", "volume", "quad"]);
  });

  test("a mesh through createViewer offers volume only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => OBJ,
    })));
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: { type: "mesh", source: "mem://mesh.obj" },
    });
    expect(viewer.dataset).toBeInstanceOf(MeshDataset);
    expect(viewer.resolvedMode).toBe("volume"); // auto → defaultMode
    expect(viewer.availableModes).toEqual(["volume"]);
    expect(viewer.engine!.getViewConfig("main")?.type).toBe("volume");
    expect(layerOf(viewer, "volume-mesh").type).toBe("surface");

    // Slice/quad are not buildable for a mesh — rejected synchronously, and
    // the running scene survives the rejected assignments.
    const engine = viewer.engine;
    expect(() => { viewer.mode = "slice"; }).toThrow(
      /Mode "slice" is not supported by dataset kind "mesh" \(available: volume\)/,
    );
    expect(() => { viewer.mode = "quad"; }).toThrow(/not supported by dataset kind "mesh"/);
    expect(viewer.engine).toBe(engine);
    expect(viewer.resolvedMode).toBe("volume");
    expect(viewer.status).toBe("ready");
  });
});

// ============================================================================
// SLICE NAVIGATION
// ============================================================================

describe("slice navigation (setSlicePoint)", () => {
  test("setSlicePoint moves every slice layer and the camera focus", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, mode: "slice" });
    // physical z=6 with spacing 2 → slice index 3 (shape z=4 → 0..3).
    viewer.setSlicePoint([2, 2, 6]);
    expect(layerOf(viewer, "slice-c0").options).toMatchObject({ sliceIndex: 3 });
    expect(layerOf(viewer, "slice-c1").options).toMatchObject({ sliceIndex: 3 });
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([2, 2, 6]);
  });

  test("quad mode syncs each plane along its own through axis", async () => {
    const { container } = makeFakeContainer();
    const viewer = await makeViewer(container, { dataset: DESC_3D, mode: "quad" });
    viewer.setSlicePoint([1, 2, 6]); // spacing [0.5, 0.5, 2]
    expect(layerOf(viewer, "quad-xy-c0").options).toMatchObject({ sliceIndex: 3 }); // through z
    expect(layerOf(viewer, "quad-xz-c0").options).toMatchObject({ sliceIndex: 4 }); // through y
    expect(layerOf(viewer, "quad-yz-c0").options).toMatchObject({ sliceIndex: 2 }); // through x
  });

  test("entering slice mode with a preserved focus shows the slice at the focus", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // auto → volume
    viewer.engine!.setTarget([1, 2, 6]);
    viewer.mode = "slice";
    await viewer.ready;
    expect(layerOf(viewer, "slice-c0").options).toMatchObject({ sliceIndex: 3 });
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([1, 2, 6]);
  });

  test("setSlicePoint is a no-op in volume mode", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // auto → volume
    const before = viewer.engine!.getState().exploration.camera.target;
    viewer.setSlicePoint([0, 0, 0]);
    expect(viewer.engine!.getState().exploration.camera.target).toEqual(before);
  });
});

// ============================================================================
// MODE OVERRIDES
// ============================================================================

describe("modeOverrides", () => {
  test("per-mode channels/tools/controls apply on mode entry only", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      mode: "slice",
      modeOverrides: {
        volume: {
          channels: [{ index: 1, visible: true, contrast: [0.1, 0.5] }],
          tools: { crosshair: true },
          controls: { fly: true },
        },
      },
    });

    // Slice: base state, no overrides.
    expect(layerOf(viewer, "slice-c1").render).toMatchObject({ visible: false, contrastLimits: [0, 1] });
    expect(viewer.engine!.getViewConfig("main")?.overlays).toEqual({});
    expect(viewer.engine!.getViewConfig("main")?.controls).toEqual({ panzoom: {} });

    // Volume: overrides applied on entry.
    viewer.mode = "volume";
    await viewer.ready;
    expect(layerOf(viewer, "volume-c1").render).toMatchObject({ visible: true, contrastLimits: [0.1, 0.5] });
    expect(layerOf(viewer, "volume-c0").render).toMatchObject({ visible: true, contrastLimits: [0, 1] });
    expect(viewer.engine!.getViewConfig("main")?.overlays).toEqual({ crosshair: {} });
    expect(viewer.engine!.getViewConfig("main")?.controls).toEqual({ fly: {} });

    // Back to slice: base state again (overrides are per-mode, not sticky).
    viewer.mode = "slice";
    await viewer.ready;
    expect(layerOf(viewer, "slice-c1").render).toMatchObject({ visible: false, contrastLimits: [0, 1] });
    expect(viewer.engine!.getViewConfig("main")?.overlays).toEqual({});
  });

  test("viewer.view(mode).configure is the imperative equivalent", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, mode: "slice" });
    viewer.view("volume").configure({ channels: [{ index: 0, contrast: [0.3, 0.7] }] });

    viewer.mode = "volume";
    await viewer.ready;
    expect(layerOf(viewer, "volume-c0").render?.contrastLimits).toEqual([0.3, 0.7]);

    // Configuring the ACTIVE mode re-enters it immediately.
    viewer.view("volume").configure({ tools: { ruler: true } });
    await viewer.ready;
    expect(viewer.engine!.getViewConfig("main")?.overlays).toEqual({ ruler: {} });
  });

  test('mode override camera: "fit" forces a re-fit, explicit target wins over focus', async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      mode: "slice",
      modeOverrides: { volume: { camera: { target: [9, 9, 9] } } },
    });
    viewer.engine!.setTarget([1, 1, 1]);
    viewer.mode = "volume";
    await viewer.ready;
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([9, 9, 9]);
  });

  test("mode override transform is baked into constructed layers and survives rebuilds", async () => {
    // A Y/Z-swap-style affine for the stub's [4, 4, 8] physical size.
    const affine = [
      4, 0, 0, 0,
      0, 0, -4, 0,
      0, 8, 0, 0,
      0, 0, 4, 1,
    ];
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      mode: "volume",
      modeOverrides: { volume: { transform: affine } },
    });

    // Headless: no render pass runs, so drive the same per-frame applyConfig
    // call `BaseView.render` makes to realize config → live model matrix.
    const liveMatrices = () => {
      const state = viewer.engine!.getState();
      return viewer.engine!.view("main").base.getLayers().map((layer) => {
        const desc = state.layers.find((l) => l.id === layer.id)!;
        layer.applyConfig(desc, state.physical);
        return [...layer.modelMatrix];
      });
    };

    // Present from birth: state config AND live model matrix, no runtime mutation.
    for (const id of ["volume-c0", "volume-c1"]) {
      expect(layerOf(viewer, id).data?.transform).toEqual(affine);
    }
    for (const m of liveMatrices()) expect(m).toEqual(affine);
    // The declarative mirror round-trips it (JSON-serializable contract).
    expect(viewer.config.modeOverrides?.volume?.transform).toEqual(affine);

    // Slice mode declares no transform: layers get the physical-space default
    // (plane-local scale for the x/y plane → diag(4, 4, 1, 1)).
    viewer.mode = "slice";
    await viewer.ready;
    expect(layerOf(viewer, "slice-c0").data?.transform).toBeUndefined();
    for (const m of liveMatrices()) {
      expect(m).toEqual([4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }

    // Back to volume: the rebuilt layers carry the affine again — the Viewer
    // owns re-application, no escape-hatch mutation needed.
    viewer.mode = "volume";
    await viewer.ready;
    expect(layerOf(viewer, "volume-c0").data?.transform).toEqual(affine);
    for (const m of liveMatrices()) expect(m).toEqual(affine);
  });

  test("view(mode).configure({ transform }) is the imperative equivalent", async () => {
    const affine = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, mode: "volume" });
    // Configuring the ACTIVE mode re-enters it immediately with the transform.
    viewer.view("volume").configure({ transform: affine });
    await viewer.ready;
    const state = viewer.engine!.getState();
    for (const layer of viewer.engine!.view("main").base.getLayers()) {
      const desc = state.layers.find((l) => l.id === layer.id)!;
      layer.applyConfig(desc, state.physical);
      expect([...layer.modelMatrix]).toEqual(affine);
    }
    expect(viewer.config.modeOverrides?.volume?.transform).toEqual(affine);
  });

  test("mode override transform validation is actionable", async () => {
    const canvas = makeFakeCanvas();
    await expect(makeViewer(canvas, {
      dataset: DESC_3D,
      modeOverrides: { volume: { transform: [1, 0, 0] } },
    })).rejects.toThrow(/modeOverrides\.volume\.transform must be an array of 16 finite numbers/);
    await expect(makeViewer(canvas, {
      dataset: DESC_3D,
      modeOverrides: { volume: { transform: new Array(16).fill(NaN) } },
    })).rejects.toThrow(/modeOverrides\.volume\.transform must be an array of 16 finite numbers/);
  });
});

// ============================================================================
// CONTROLS + TOOLS (DX-M6)
// ============================================================================

describe("controls and tools runtime parity", () => {
  test("declarative controls land in the view config; defaults follow the mode", async () => {
    const custom = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      controls: { orbit: { zoomSensitivity: 1.4 } },
    });
    expect(custom.engine!.getViewConfig("main")?.controls).toEqual({ orbit: { zoomSensitivity: 1.4 } });

    const off = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, controls: {} });
    expect(off.engine!.getViewConfig("main")?.controls).toEqual({});
    expect(controlTypes(off)).toEqual([]);
  });

  test("control().configure/enable rebuild the live control chain with typed options", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // volume → orbit default
    expect(viewer.control("orbit").enabled).toBe(true);
    expect(viewer.control("panzoom").enabled).toBe(false);
    expect(controlTypes(viewer)).toEqual(["orbit"]);

    viewer.control("orbit").configure({ zoomSensitivity: 2 });
    expect(controlTypes(viewer)).toEqual(["orbit"]);

    viewer.control("orbit").enable(false);
    expect(viewer.control("orbit").enabled).toBe(false);
    expect(controlTypes(viewer)).toEqual([]);

    viewer.control("fly").enable();
    expect(controlTypes(viewer)).toEqual(["fly"]);

    // Declarative mirror stays in sync for rebuilds.
    viewer.mode = "slice";
    await viewer.ready;
    expect(controlTypes(viewer)).toEqual(["fly"]);

    expect(() => viewer.control("warp" as never)).toThrow(/Unknown control/);
  });

  test("declarative tools expand to typed overlay configs", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      tools: { crosshair: true, ruler: { visible: false }, magnifier: "2d" },
    });
    expect(viewer.engine!.getViewConfig("main")?.overlays).toEqual({
      crosshair: {},
      ruler: { visible: false },
      "magnifier-2d": {},
    });
    expect(overlayKeys(viewer)).toEqual(["crosshair", "ruler", "magnifier-2d"]);
    expect(liveOverlays(viewer)).toHaveLength(3);
    expect(viewer.tool("ruler").enabled).toBe(false); // attached but hidden
    expect(viewer.tool("crosshair").enabled).toBe(true);
  });

  test("tool().configure/enable attach, update, and detach live overlays", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, mode: "slice" });
    expect(viewer.tool("ruler").enabled).toBe(false);
    expect(liveOverlays(viewer)).toHaveLength(0);

    viewer.tool("ruler").enable();
    expect(liveOverlays(viewer)).toHaveLength(1);
    expect(viewer.tool("ruler").enabled).toBe(true);
    const rulerInstance = liveOverlays(viewer)[0];

    viewer.tool("ruler").configure({ unit: "µm" });
    expect(liveOverlays(viewer)).toHaveLength(1); // updated in place
    expect(liveOverlays(viewer)[0]).toBe(rulerInstance);

    // Magnifier with a pinned dimension maps to the matching overlay type.
    viewer.tool("magnifier").configure({ dimension: "3d", zoom: 8 });
    expect(liveOverlays(viewer)).toHaveLength(2);
    const magnifier3d = liveOverlays(viewer)[1];

    // Swapping the pinned dimension replaces the overlay (the type changes).
    viewer.tool("magnifier").configure({ dimension: "2d" });
    expect(liveOverlays(viewer)).toHaveLength(2);
    expect(liveOverlays(viewer)[0]).toBe(rulerInstance);
    expect(liveOverlays(viewer)[1]).not.toBe(magnifier3d);

    viewer.tool("ruler").enable(false);
    expect(liveOverlays(viewer)).toHaveLength(1);

    // Tool intent survives mode transitions (rebuilt from the declarative mirror).
    viewer.tool("crosshair").enable();
    viewer.mode = "volume";
    await viewer.ready;
    expect(viewer.engine!.getViewConfig("main")?.overlays).toMatchObject({
      crosshair: {},
      "magnifier-2d": {},
    });

    expect(() => viewer.tool("laser" as never)).toThrow(/Unknown tool/);
  });

  test("magnifier dimension defaults to the view kind when unpinned", async () => {
    const volumeViewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, tools: { magnifier: {} } });
    expect(volumeViewer.engine!.getViewConfig("main")?.overlays).toEqual({ "magnifier-3d": {} });

    const sliceViewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      mode: "slice",
      tools: { magnifier: { zoom: 6 } },
    });
    expect(sliceViewer.engine!.getViewConfig("main")?.overlays).toEqual({ "magnifier-2d": { zoom: 6 } });

    // A bare `true` is outside the schema (a dimension pin or options bag is required).
    await expect(
      makeViewer(makeFakeCanvas(), { dataset: DESC_3D, tools: { magnifier: true as never } }),
    ).rejects.toThrow(/tools\.magnifier/);
  });
});

// ============================================================================
// CAMERA
// ============================================================================

describe("camera", () => {
  test('config camera "fit" uses the dataset bounds; partials merge over fit', async () => {
    const fit = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(fit.engine!.getState().exploration.camera.target).toEqual([2, 2, 4]);

    const partial = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      camera: { target: [1, 1, 1], projMode: "orthographic" },
    });
    const cam = partial.engine!.getState().exploration.camera;
    expect(cam.target).toEqual([1, 1, 1]);
    expect(cam.projMode).toBe("orthographic");
    expect(cam.navMode).toBe("orbit"); // fit default preserved
  });

  test("setCamera merges over the current camera; fitCamera reframes", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.setCamera({ target: [3, 3, 3] });
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([3, 3, 3]);
    viewer.setCamera("fit");
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([2, 2, 4]);
    viewer.setCamera({ target: [0, 0, 0] });
    viewer.fitCamera();
    expect(viewer.engine!.getState().exploration.camera.target).toEqual([2, 2, 4]);
  });
});

// ============================================================================
// QUAD MODE
// ============================================================================

describe("quad mode", () => {
  test("container target lays out three slice planes plus a volume view", async () => {
    const { container, el } = makeFakeContainer();
    const viewer = await makeViewer(container, { dataset: DESC_3D, mode: "quad" });
    expect(viewer.resolvedMode).toBe("quad");

    const engine = viewer.engine!;
    for (const [id, axes] of [["quad-xy", ["x", "y"]], ["quad-xz", ["x", "z"]], ["quad-yz", ["y", "z"]]] as const) {
      const view = engine.getViewConfig(id)!;
      expect(view.type).toBe("slice");
      expect(view.layers).toEqual([`${id}-c0`, `${id}-c1`]);
      expect(view.controls).toEqual({ panzoom: {} });
      expect(layerOf(viewer, `${id}-c0`).options?.axes).toEqual(axes);
      expect(layerOf(viewer, `${id}-c0`).options?.selection).toEqual({ c: 0 });
    }
    const volume = engine.getViewConfig("quad-3d")!;
    expect(volume.type).toBe("volume");
    expect(volume.controls).toEqual({ orbit: {} });
    expect(layerOf(viewer, "quad-3d-c1").render?.volumeProjection).toBe("mip");

    // The viewer owns a 2×2 grid with four canvases.
    expect(el.children).toHaveLength(1);
    expect(el.children[0].children).toHaveLength(4);
    viewer.destroy();
    expect(el.children).toHaveLength(0);
  });

  test("a user-passed canvas rejects quad with an actionable error", async () => {
    await expect(makeViewer(makeFakeCanvas(), { dataset: DESC_3D, mode: "quad" })).rejects.toThrow(
      /quad.*requires a container element/,
    );
  });
});

// ============================================================================
// SERIALIZATION
// ============================================================================

describe("serialization", () => {
  test("ViewerConfig is JSON-serializable and round-trips", async () => {
    const config: ViewerConfig = {
      dataset: DESC_3D,
      mode: "auto",
      channels: [{ index: 1, visible: true, color: "#00FF00", contrast: [0.2, 0.8] }],
      projection: "minip",
      camera: "fit",
      controls: { orbit: { zoomSensitivity: 1.4 } },
      tools: { crosshair: true, magnifier: "3d" },
      modeOverrides: { slice: { channels: [{ index: 0, contrast: [0, 0.5] }] } },
    };
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);

    const viewer = await makeViewer(makeFakeCanvas(), config);
    const emitted = viewer.config;
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(emitted);
    expect(emitted.dataset).toEqual(DESC_3D);
    expect(emitted.channels).toHaveLength(2);
    expect(emitted.projection).toBe("minip");
  });

  test("viewer.config reflects imperative changes (parity mirror)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.channel(1).configure({ visible: true, contrast: [0.1, 0.2] });
    viewer.projection = "mean";
    const emitted = viewer.config;
    const channel = emitted.channels!.find((c) => c.index === 1)!;
    expect(channel).toMatchObject({ visible: true, contrast: [0.1, 0.2] });
    expect(emitted.projection).toBe("mean");
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(emitted);
  });
});

// ============================================================================
// ESCAPE HATCH + TEARDOWN
// ============================================================================

describe("escape hatch and teardown", () => {
  test("viewer.engine exposes the low-level instance; replaced on transitions", async () => {
    const viewer = await makeViewer();
    expect(viewer.engine).toBeUndefined();
    await viewer.open(DESC_3D);
    const first = viewer.engine;
    expect(first).toBeInstanceOf(ViewerEngine);
    viewer.mode = "slice";
    await viewer.ready;
    expect(viewer.engine).toBeInstanceOf(ViewerEngine);
    expect(viewer.engine).not.toBe(first);
  });

  test("destroy tears down; further operations reject", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.destroy();
    expect(viewer.engine).toBeUndefined();
    expect(viewer.status).toBe("idle");
    await expect(viewer.open(DESC_3D)).rejects.toThrow(/destroyed/);
    expect(() => { viewer.mode = "slice"; }).toThrow(/destroyed/);
    viewer.destroy(); // idempotent
  });
});

// ============================================================================
// SITE-CHROME PASS-THROUGH (theme / autoRotate) + CHANNEL COMPOSITING
// ============================================================================

describe("theme, autoRotate, and channel compositing", () => {
  test("config.theme is forwarded to createViewerEngine (overlays resolve it)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      theme: { accent: "#123456" },
    });
    expect(viewer.engine!.theme.accent).toBe("#123456");
    // Untouched fields fall back to the default theme.
    expect(viewer.engine!.theme.warn).toBe("#FFC966");
    // The declarative mirror round-trips it (JSON-serializable).
    expect(viewer.config.theme).toEqual({ accent: "#123456" });
  });

  test("config.autoRotate lands on volume view configs only", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      autoRotate: { speedDegPerSec: 8 },
    });
    expect(viewer.engine!.getViewConfig("main")?.autoRotate).toEqual({ speedDegPerSec: 8 });
    viewer.mode = "slice";
    await viewer.ready;
    expect(viewer.engine!.getViewConfig("main")?.autoRotate).toBeUndefined();
  });

  test("autoRotate is off by default and validates its options bag", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(viewer.engine!.getViewConfig("main")?.autoRotate).toBeUndefined();
    await expect(
      makeViewer(makeFakeCanvas(), { autoRotate: { speedDegPerSec: Number.NaN } }),
    ).rejects.toThrow(/autoRotate\.speedDegPerSec/);
  });

  test("generated channel layers composite additively (multichannel default)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(layerOf(viewer, "volume-c0").render?.blending).toBe("additive");
    expect(layerOf(viewer, "volume-c1").render?.blending).toBe("additive");
    viewer.mode = "slice";
    await viewer.ready;
    expect(layerOf(viewer, "slice-c0").render?.blending).toBe("additive");
  });
});
