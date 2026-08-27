// @vitest-environment jsdom

/**
 * Composition contract tests (one resolution path): built-in and custom
 * compositions — direct or registered — traverse the same
 * resolve/build/mount path through the facade.
 *
 * Covered here:
 * - a DIRECT custom composition (`{ implementation }`) drives a viewer
 *   without any registration;
 * - a direct composition WITHOUT a portable reference makes getState() fail
 *   explicitly (never an unportable document); WITH a reference it round-trips;
 * - a REGISTERED custom composition resolves from a `{ type }` reference, in
 *   creation config, setComposition, and setState restore;
 * - registerComposition rejects duplicates and supports unregister;
 * - the custom composition's plan drives the Viewer's DOM (a two-view split),
 *   bindings (channel updates), and layout exactly like a built-in;
 * - the "auto" policy considers registered compositions in resolution order.
 *
 * Harness: jsdom DOM + fake WebGPU device; a stub Dataset kind.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CapabilityResolutionError,
  createViewer,
  Dataset,
  registerComposition,
  registerDatasetAdapter,
  type DatasetConfig,
  type Viewer,
  type ViewerConfig,
} from "../../src/index";
import {
  buildImageLayers,
  primaryResourceOf,
  type CompositionPlan,
  type ViewerComposition,
} from "../../src/viewer/compositions";
import { datasetRegistry } from "../../src/registry";
import type { ImagePyramid } from "../../src/state/schema";

// ============================================================================
// STUB DATASET KIND
// ============================================================================

const KIND = "contract-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "contract-stub": { type: "contract-stub"; source: string };
  }
}

const PYRAMID_3D: ImagePyramid = {
  levels: [
    { path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [0.5, 0.5, 2] },
  ],
};

const DESC: DatasetConfig = { type: KIND, source: "mem://3d" };

class StubDataset extends Dataset {
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    this.physical = { spatial: { size: [4, 4, 8], spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } };
    this.dimensions = [{ name: "c", size: 2 }];
    this.defaultSelection = { c: 0 };
    this.channels = [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: true },
    ];
    this.resources = [{
      id: "image",
      kind: "image-pyramid",
      pyramid: PYRAMID_3D,
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
// CUSTOM COMPOSITION — a two-view slice split built with the shared builders
// ============================================================================

/**
 * "split": two slice views side by side (grid layout, pool 2), proving a
 * custom composition's plan drives the Viewer exactly like a built-in.
 */
const splitComposition: ViewerComposition = {
  type: "split",

  supports(dataset) {
    return primaryResourceOf(dataset)?.kind === "image-pyramid";
  },

  build({ dataset, channels, transform }): CompositionPlan {
    const primary = primaryResourceOf(dataset);
    if (primary?.kind !== "image-pyramid") {
      throw new Error(`split cannot build for dataset kind "${dataset.type}"`);
    }
    const layers = ["split-a", "split-b"].flatMap((prefix) =>
      buildImageLayers(primary, { view: "slice", prefix, channels, transform }),
    );
    return {
      layers,
      views: {
        "split-a": { type: "slice", layers: layers.slice(0, channels.length).map((l) => l.id) },
        "split-b": { type: "slice", layers: layers.slice(channels.length).map((l) => l.id) },
      },
      activeViewId : "split-a",
      layout       : { kind: "grid", pool: 2 },
      bindings     : {
        channels: new Map(channels.map((channel) => [
          channel.index,
          [`split-a-c${channel.index}`, `split-b-c${channel.index}`],
        ])),
        projectionLayers : [],
        slicePlanes      : [],
      },
    };
  },
};

// ============================================================================
// FAKE WEBGPU
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
let unregisterSplit: (() => void) | undefined;

beforeEach(() => {
  viewers = [];
  unregisterSplit = undefined;
  stubWebGPU();
  HTMLCanvasElement.prototype.getContext = (() => ({
    configure() {},
    unconfigure() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  registerDatasetAdapter(KIND, (config) => new StubDataset(config));
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  unregisterSplit?.();
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

async function makeViewer(config: ViewerConfig): Promise<Viewer> {
  const viewer = await createViewer(makeContainer(), config);
  viewers.push(viewer);
  return viewer;
}

function layerOf(viewer: Viewer, id: string) {
  const layer = viewer.runtime!.getState().layers!.find((l) => l.id === id);
  expect(layer, `layer "${id}"`).toBeDefined();
  return layer!;
}

// ============================================================================
// DIRECT COMPOSITIONS
// ============================================================================

describe("direct custom composition ({ implementation })", () => {
  test("drives the viewer without any registration — same build/mount path", async () => {
    const viewer = await makeViewer({
      dataset    : DESC,
      composition: { implementation: splitComposition },
    });
    expect(viewer.resolvedComposition).toBe("split");
    // The plan's layout drove the Viewer's DOM and view configs.
    expect(viewer.runtime!.getViewConfig("split-a")?.type).toBe("slice");
    expect(viewer.runtime!.getViewConfig("split-b")?.layers).toEqual(["split-b-c0", "split-b-c1"]);
    // Bindings drive channel updates across both views.
    viewer.channel(0).configure({ color: "#FF0000" });
    expect(layerOf(viewer, "split-a-c0").render?.color).toBe("#FF0000");
    expect(layerOf(viewer, "split-b-c0").render?.color).toBe("#FF0000");
  });

  test("without a reference, getState() fails explicitly (never an unportable document)", async () => {
    const viewer = await makeViewer({
      dataset    : DESC,
      composition: { implementation: splitComposition },
    });
    expect(() => viewer.getState()).toThrow(/without a portable `reference`/);
  });

  test("with a reference, getState() emits it and setState restores through the registry", async () => {
    const viewer = await makeViewer({
      dataset    : DESC,
      composition: { implementation: splitComposition, reference: { type: "split" } },
    });
    const state = viewer.getState();
    expect(state.composition).toEqual({ type: "split" });

    // The receiving viewer resolves the reference through the registry —
    // the document is portable only when the receiver provides the type.
    const receiver = await createViewer(makeContainer(), {});
    viewers.push(receiver);
    await expect(receiver.setState(state)).rejects.toThrow(CapabilityResolutionError);
    unregisterSplit = registerComposition("split", splitComposition);
    await receiver.setState(JSON.parse(JSON.stringify(state)));
    expect(receiver.resolvedComposition).toBe("split");
    expect(layerOf(receiver, "split-b-c1")).toBeDefined();
  });
});

// ============================================================================
// REGISTERED COMPOSITIONS
// ============================================================================

describe("registered custom composition", () => {
  test("resolves from a { type } reference like a built-in", async () => {
    unregisterSplit = registerComposition("split", splitComposition);
    const viewer = await makeViewer({ dataset: DESC, composition: { type: "split" } });
    expect(viewer.resolvedComposition).toBe("split");
    expect(viewer.availableCompositions).toEqual(["slice", "volume", "quad", "grid", "split"]);
    expect(layerOf(viewer, "split-a-c0").type).toBe("slice");
  });

  test("joins the auto policy's fallback order (registered last → never auto-picked for images)", async () => {
    unregisterSplit = registerComposition("split", splitComposition);
    const viewer = await makeViewer({ dataset: DESC }); // auto → volume
    expect(viewer.resolvedComposition).toBe("volume");
    await viewer.setComposition({ type: "split" });
    expect(viewer.resolvedComposition).toBe("split");
    await viewer.setComposition("auto");
    expect(viewer.resolvedComposition).toBe("volume");
  });

  test("duplicate registration throws; unregister releases the key", () => {
    const unregister = registerComposition("split", splitComposition);
    expect(() => registerComposition("split", splitComposition)).toThrow(
      /Duplicate composition type registration: "split"/,
    );
    unregister();
    // The key is free again.
    unregisterSplit = registerComposition("split", splitComposition);
  });

  test("a type/identity mismatch is rejected at registration", () => {
    expect(() => registerComposition("other-name", splitComposition)).toThrow(
      /the registry key and the composition type must agree/,
    );
  });
});
