// @vitest-environment jsdom

/**
 * Portable Viewer state tests: `viewer.getState()` / `await
 * viewer.setState(state)` / `viewer.subscribe(listener)` — over the ONE
 * unified {@link State} document (no separate ViewerState).
 *
 * Covered here:
 * - creation config -> getState normalization (resolved composition
 *   reference, fully resolved channels, concrete live camera — never
 *   "auto"/"fit"; no layers in a facade document);
 * - plain-JSON round trips: getState -> JSON.parse(JSON.stringify(...)) ->
 *   validateState -> setState;
 * - imperative composition/channel/projection/camera changes -> state;
 * - CONTROL-driven camera changes -> state (the camera mirror is live);
 * - ROI edits -> state (mirrored into tool VALUES before the Viewer event);
 * - setState atomicity: same-dataset restore without a duplicate metadata
 *   open, changed-dataset restore with ownership transfer and cleanup,
 *   validation/composition-resolution/dataset-open failures preserving the
 *   old viewer (preflight before teardown), GPU/mount failure leaving no
 *   partial state or leaked resources, rapid calls settling on the last state;
 * - slice/quad restoration synchronizing every generated slice layer to the
 *   camera target (the canonical physical focus);
 * - subscriptions emitting exactly one committed snapshot per rebuild and
 *   unsubscribing cleanly;
 * - adopted datasets serializing through `dataset.config` without a reopen.
 *
 * Harness: jsdom DOM + fake WebGPU device (rAF stubbed — no render pass
 * runs); stub + dispose-spy Dataset kinds; the real "ome-zarr" kind against
 * a stubbed fetch for metadata-open counting.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDatasetAdapter,
  validateState,
  ViewerSupersededError,
  type DatasetConfig,
  type RoiBox,
  type State,
  type Viewer,
  type ViewerConfig,
} from "../../src/index";
import { RoiSelectorOverlay } from "../../src/index";
import { OMEZarrDataset } from "../../src/dataset/adapters/ome-zarr";
import { datasetRegistry } from "../../src/registry";
import type { ImagePyramid } from "../../src/state/schema";

// ============================================================================
// STUB DATASET KINDS
// ============================================================================

const KIND = "state-stub";
const SPY_KIND = "state-spy";

declare module "galavi" {
  interface DatasetConfigMap {
    "state-stub": { type: "state-stub"; source: string };
    "state-spy": { type: "state-spy"; source: string };
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

const DESC_3D: DatasetConfig = { type: KIND, source: "mem://3d" };
const DESC_2D: DatasetConfig = { type: KIND, source: "mem://2d" };
const DESC_OTHER: DatasetConfig = { type: KIND, source: "mem://other" };
const DESC_FAIL: DatasetConfig = { type: KIND, source: "mem://fail" };

const SPY_A: DatasetConfig = { type: SPY_KIND, source: "mem://spy-a" };
const SPY_B: DatasetConfig = { type: SPY_KIND, source: "mem://spy-b" };

class StubPyramidDataset extends Dataset {
  pyramid: ImagePyramid = PYRAMID_3D;
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    const source = this.config.source;
    if (source === DESC_FAIL.source) {
      const cause = new Error("No OME-Zarr multiscales metadata found");
      throw Object.assign(new Error(`Failed to open ${source}`), { cause });
    }
    this.pyramid = source === DESC_2D.source ? PYRAMID_2D : PYRAMID_3D;
    this.physical = { spatial: { size: [4, 4, 8], unit: "μm", spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } };
    this.dimensions = [{ name: "c", size: 2, labels: ["a", "b"] }];
    this.defaultSelection = { c: 0 };
    this.channels = [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: false },
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

class SpyDataset extends Dataset {
  readonly disposeSpy = vi.fn();
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    this.physical = { spatial: { size: [4, 4, 8], spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } };
    this.dimensions = [{ name: "c", size: 1, labels: ["a"] }];
    this.defaultSelection = { c: 0 };
    this.channels = [{ index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true }];
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

  override dispose(): void {
    this.disposeSpy();
  }
}

/** Registry-made spy instances, for ownership/cleanup assertions. */
let created: SpyDataset[];

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

/** GPU init fails the way a WebGPU-less browser fails. */
function stubWebGPUMissing(): void {
  vi.stubGlobal("navigator", {
    gpu: { requestAdapter: async () => null, getPreferredCanvasFormat: () => "bgra8unorm" },
  });
}

const realGetContext = HTMLCanvasElement.prototype.getContext;

function makeHostCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, {
    clientWidth  : { value: 256 },
    clientHeight : { value: 256 },
  });
  document.body.appendChild(canvas);
  return canvas;
}

function makeHostContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

// ============================================================================
// HARNESS
// ============================================================================

let viewers: Viewer[];

beforeEach(() => {
  viewers = [];
  created = [];
  stubWebGPU();
  HTMLCanvasElement.prototype.getContext = (() => ({
    configure() {},
    unconfigure() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  registerDatasetAdapter(KIND, (config) => new StubPyramidDataset(config));
  registerDatasetAdapter(SPY_KIND, (config) => {
    const dataset = new SpyDataset(config);
    created.push(dataset);
    return dataset;
  });
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  datasetRegistry.unregister(SPY_KIND);
  HTMLCanvasElement.prototype.getContext = realGetContext;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function makeViewer(
  element: HTMLElement = makeHostCanvas(),
  config: ViewerConfig = {},
): Promise<Viewer> {
  const viewer = await createViewer(element, config);
  viewers.push(viewer);
  return viewer;
}

function layerOf(viewer: Viewer, id: string) {
  const layer = viewer.runtime!.getState().layers!.find((l) => l.id === id);
  expect(layer, `layer "${id}"`).toBeDefined();
  return layer!;
}

function roiOverlay(viewer: Viewer, viewId = "main"): RoiSelectorOverlay {
  const overlay = viewer.runtime!.view(viewId).base.getOverlays()
    .find((candidate) => candidate instanceof RoiSelectorOverlay);
  expect(overlay, `roiselector overlay in view "${viewId}"`).toBeDefined();
  return overlay as RoiSelectorOverlay;
}

/** The canonical portable form: getState through plain JSON and validateState. */
function portable(viewer: Viewer): State {
  return validateState(JSON.parse(JSON.stringify(viewer.getState())), "test round-trip");
}

// ============================================================================
// GETSTATE — NORMALIZATION + LIVE MIRRORING
// ============================================================================

describe("getState normalization", () => {
  test("an idle viewer has no portable state", async () => {
    const viewer = await makeViewer();
    expect(() => viewer.getState()).toThrow(/no committed scene/);
  });

  test("creation config normalizes: resolved composition, resolved channels, concrete camera", async () => {
    const viewer = await makeViewer(makeHostCanvas(), {
      dataset     : DESC_3D,
      composition : "auto",
      channels    : [{ index: 1, visible: true, contrast: [0.2, 0.8] }],
      camera      : "fit",
      controls    : { orbit: { zoomSensitivity: 1.4 } },
      tools       : { crosshair: true },
      theme       : { accent: "#123456" },
      autoRotate  : { speedDegPerSec: 8 },
    });
    const state = viewer.getState();
    // "auto" and "fit" are creation intent — the snapshot is concrete.
    expect(state.composition).toEqual({ type: "volume" });
    expect(state.channels).toEqual([
      { index: 0, label: "a", visible: true, color: "#00B0FF", contrast: [0, 1] },
      { index: 1, label: "b", visible: true, color: "#FF3D3D", contrast: [0.2, 0.8] },
    ]);
    expect(state.projection).toBe("mip");
    expect(state.exploration.camera.navMode).toBe("orbit");
    expect(state.exploration.camera.projMode).toBe("perspective");
    expect(state.exploration.camera.target).toEqual([2, 2, 4]);
    expect(state.dataset).toEqual(DESC_3D);
    // A facade document omits `layers` (re-derived by the composition).
    expect(state.layers).toBeUndefined();
    // theme/autoRotate/control+tool OPTIONS are viewer-local (ViewerConfig
    // only) — they leave the portable state.
    expect(state).not.toHaveProperty("controls");
    expect(state).not.toHaveProperty("tools"); // crosshair: true is an option, not a value
    expect(state).not.toHaveProperty("theme");
    expect(state).not.toHaveProperty("autoRotate");
    // Pure JSON, and Unicode labels survive the round trip.
    viewer.channel(0).configure({ label: "通道 µm" });
    const labeled = portable(viewer);
    expect(labeled.channels![0].label).toBe("通道 µm");
    expect(JSON.parse(JSON.stringify(labeled))).toEqual(labeled);
  });

  test("imperative composition/channel/projection/camera changes are reflected", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    await viewer.setComposition({ type: "slice" });
    viewer.channel(1).configure({ visible: true, contrast: [0.1, 0.4] });
    viewer.projection = "mean";
    viewer.setCamera({ position: [2, 2, 20] });
    viewer.tool("ruler").enable();

    const state = viewer.getState();
    expect(state.composition).toEqual({ type: "slice" });
    expect(state.channels![1]).toMatchObject({ visible: true, contrast: [0.1, 0.4] });
    expect(state.projection).toBe("mean");
    expect(state.exploration.camera.position).toEqual([2, 2, 20]);
    expect(state.exploration.camera.target).toEqual([2, 2, 4]); // untouched by the partial merge
    // Tool options are viewer-local: enabling the ruler does not enter State.
    expect(state).not.toHaveProperty("tools");
  });

  test("control-driven camera changes are mirrored into the live state", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const before = viewer.getState().exploration.camera;

    // The seam DOM input funnels into: view controls -> runtime state commit.
    viewer.runtime!.view("main").base.forward({
      type: "mouse:drag",
      payload: { dx: 0.5, dy: 0.2, aspect: 1 },
    });

    const after = viewer.getState().exploration.camera;
    expect(after.position).not.toEqual(before.position);
    expect(after.target).toEqual(before.target); // orbit keeps the focal point
  });
});

// ============================================================================
// ROI EDITS -> STATE
// ============================================================================

const BOX_A: RoiBox = { min: [1, 1, 0], max: [3, 3, 3] };
const BOX_B: RoiBox = { min: [5, 5, 0], max: [7, 7, 3] };

describe("ROI edits mirror into tool values", () => {
  test("roi edits and active selection appear under tools.roi before the event emits", async () => {
    const container = makeHostContainer();
    const canvas = makeHostCanvas();
    container.appendChild(canvas);
    const viewer = await makeViewer(canvas, {
      dataset    : DESC_3D,
      composition: { type: "slice" },
      tools      : { roi: { rois: [BOX_A, BOX_B], activeIndex: 1 } },
    });
    roiOverlay(viewer).render(viewer.runtime!.getState());

    let stateInHandler: State | undefined;
    viewer.on("roiChange", () => { stateInHandler = viewer.getState(); });

    const remove = container.querySelectorAll('button[aria-label="Remove selection"]');
    expect(remove).toHaveLength(2);
    (remove[1] as HTMLButtonElement).click();

    // The mirror lands BEFORE the Viewer event emits.
    expect(stateInHandler?.tools).toMatchObject({ roi: { rois: [BOX_A] } });
    const state = portable(viewer);
    expect(state.tools).toMatchObject({ roi: { rois: [BOX_A], activeIndex: null } });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

// ============================================================================
// SETSTATE — RESTORE SEMANTICS
// ============================================================================

describe("setState restore semantics", () => {
  test("a full state round-trips exactly through setState -> getState", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const state: State = {
      ...portable(viewer),
      channels: [
        { index: 0, label: "DAPI", visible: false, color: "#00FF00", contrast: [0.1, 0.9] },
        { index: 1, label: "GFP", visible: true, color: "#FF3D3D", contrast: [0.2, 0.8] },
      ],
      projection: "minip",
      exploration: {
        camera: {
          navMode: "orbit", projMode: "perspective",
          position: [6, 6, 18], target: [2, 2, 4],
        },
      },
      compositions: { slice: { channels: [{ index: 0, contrast: [0, 0.5] }] } },
      tools: { roi: { rois: [{ min: [0, 0, 0], max: [1, 1, 2] }], activeIndex: 0 } },
    };
    await viewer.setState(state);
    expect(viewer.getState()).toEqual(state);
    // The scene itself reflects the restore (not just the mirror).
    expect(layerOf(viewer, "volume-c0").render).toMatchObject({
      visible: false, color: "#00FF00", contrastLimits: [0.1, 0.9],
    });
    expect(viewer.runtime!.getState().exploration.camera.position).toEqual([6, 6, 18]);
  });

  test("slice restoration synchronizes the slice layer to the camera target", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D, composition: { type: "slice" } });
    viewer.setSlicePoint([2, 2, 6]);
    const captured = portable(viewer);
    expect(captured.exploration.camera.target).toEqual([2, 2, 6]);

    // Move elsewhere, then restore: the visible slice follows the target.
    viewer.setSlicePoint([2, 2, 2]);
    await viewer.setState(captured);
    expect(viewer.getState().exploration.camera.target).toEqual([2, 2, 6]);
    // z spacing is 2 → slice index 3 on every generated slice layer.
    expect(layerOf(viewer, "slice-c0").options?.sliceIndex).toBe(3);
    expect(layerOf(viewer, "slice-c1").options?.sliceIndex).toBe(3);
  });

  test("quad restoration synchronizes every plane's slice layers to the focus", async () => {
    const viewer = await makeViewer(makeHostContainer(), { dataset: DESC_3D, composition: { type: "quad" } });
    viewer.setSlicePoint([1, 2, 4]);
    const captured = portable(viewer);

    viewer.setSlicePoint([0, 0, 0]);
    await viewer.setState(captured);
    expect(viewer.getState().exploration.camera.target).toEqual([1, 2, 4]);
    // Per-plane through axes with spacing [0.5, 0.5, 2]: xy→z=2, xz→y=4, yz→x=2.
    expect(layerOf(viewer, "quad-xy-c0").options?.sliceIndex).toBe(2);
    expect(layerOf(viewer, "quad-xz-c0").options?.sliceIndex).toBe(4);
    expect(layerOf(viewer, "quad-yz-c0").options?.sliceIndex).toBe(2);
  });

  test("an adopted dataset serializes through dataset.config and is not reopened", async () => {
    const adopted = new SpyDataset(SPY_A);
    await adopted.load();
    const viewer = await makeViewer();
    await viewer.open(adopted);

    const state = viewer.getState();
    expect(state.dataset).toEqual(SPY_A);
    await viewer.setState(portable(viewer));
    // Same live instance — no reopen, no disposal.
    expect(viewer.dataset).toBe(adopted);
    expect(created).toHaveLength(0); // the registry never ran
    expect(adopted.disposeSpy).not.toHaveBeenCalled();
  });

  test("one State applies across compositions, preserving channels/camera/ROIs", async () => {
    const container = makeHostContainer();
    const viewer = await makeViewer(container, {
      dataset    : DESC_3D,
      composition: { type: "slice" },
      tools      : { roi: { rois: [BOX_A], activeIndex: 0 } },
    });
    viewer.channel(1).configure({ visible: true, contrast: [0.3, 0.7] });
    viewer.setSlicePoint([2, 2, 6]);
    const shared = portable(viewer);

    // The SAME document re-interpreted by the volume composition: channels,
    // camera, and ROI values survive the transition.
    await viewer.setState({ ...shared, composition: { type: "volume" } });
    const volumeState = viewer.getState();
    expect(volumeState.composition).toEqual({ type: "volume" });
    expect(volumeState.channels).toEqual(shared.channels);
    expect(volumeState.exploration.camera.target).toEqual([2, 2, 6]);
    expect(volumeState.tools).toEqual(shared.tools);

    // …and back to slice, still identical channel/camera/ROI state.
    await viewer.setState({ ...shared, composition: { type: "slice" } });
    const sliceState = viewer.getState();
    expect(sliceState.channels).toEqual(shared.channels);
    expect(sliceState.exploration.camera.target).toEqual([2, 2, 6]);
    expect(sliceState.tools).toEqual(shared.tools);
    expect(layerOf(viewer, "slice-c0").options?.sliceIndex).toBe(3);
  });

  test("one State applied to two viewers produces equivalent scenes", async () => {
    const first = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    first.channel(0).configure({ contrast: [0.2, 0.6] });
    first.setCamera({ position: [4, 4, 20], target: [2, 2, 2] });
    const shared = portable(first);

    const second = await makeViewer(makeHostCanvas(), { state: shared });
    expect(second.getState()).toEqual(shared);
    expect(layerOf(second, "volume-c0").render?.contrastLimits).toEqual([0.2, 0.6]);
    expect(second.runtime!.getState().exploration.camera.position).toEqual([4, 4, 20]);
  });

  test("createViewer rejects state combined with an explicit dataset or composition", async () => {
    const seeded = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const state = portable(seeded);
    await expect(makeViewer(makeHostCanvas(), { state, dataset: DESC_2D })).rejects.toThrow(
      /state supplies the dataset and the composition/,
    );
    await expect(makeViewer(makeHostCanvas(), {
      state, composition: { type: "slice" },
    })).rejects.toThrow(/state supplies the dataset and the composition/);
  });
});

// ============================================================================
// SETSTATE — ATOMICITY
// ============================================================================

describe("setState atomicity", () => {
  test("validation failures preserve the current viewer completely", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const runtime = viewer.runtime;
    const before = viewer.getState();

    // "auto" is creation intent, never a stored reference.
    await expect(viewer.setState({ ...before, composition: { type: "auto" } }))
      .rejects.toThrow(/"auto" is creation-time selection intent/);
    // A legacy/foreign document (a `mode` key, a top-level `camera`) is
    // rejected by key.
    await expect(viewer.setState({ mode: "slice", camera: {} } as never))
      .rejects.toThrow(/unknown key "mode"/);
    // Channels/camera are validated as part of the document.
    await expect(viewer.setState({ ...before, channels: [], exploration: undefined as never }))
      .rejects.toThrow(/exploration/);

    expect(viewer.status).toBe("ready"); // untouched — not even status churn
    expect(viewer.runtime).toBe(runtime);
    expect(viewer.getState()).toEqual(before);
  });

  test("an unknown composition reference fails preflight without teardown", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const runtime = viewer.runtime;
    const before = viewer.getState();

    await expect(viewer.setState({ ...before, composition: { type: "no-such-composition" } }))
      .rejects.toThrow(/Unknown composition type: "no-such-composition"/);
    expect(viewer.status).toBe("error");
    expect(viewer.runtime).toBe(runtime); // the old scene still runs
    expect(viewer.getState()).toEqual(before);

    // The viewer recovers through a valid restore.
    await viewer.setState(before);
    expect(viewer.status).toBe("ready");
  });

  test("an unsupported composition fails before teardown and preserves the scene", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_2D });
    const runtime = viewer.runtime;
    const before = viewer.getState();

    await expect(viewer.setState({ ...before, composition: { type: "volume" } }))
      .rejects.toThrow(/Composition "volume" is not supported by dataset kind "state-stub"/);
    expect(viewer.status).toBe("error");
    expect(viewer.runtime).toBe(runtime); // the old scene still runs
    expect(viewer.getState()).toEqual(before);

    // The viewer recovers through a valid restore.
    await viewer.setState(before);
    expect(viewer.status).toBe("ready");
  });

  test("a multi-view composition on a caller-owned canvas fails before teardown", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const runtime = viewer.runtime;
    await expect(viewer.setState({ ...viewer.getState(), composition: { type: "quad" } }))
      .rejects.toThrow(/quad.*requires a container element/);
    expect(viewer.runtime).toBe(runtime);
    expect(viewer.getState().composition).toEqual({ type: "volume" });
  });

  test("dataset-open failure preserves the old viewer and retries cleanly", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const runtime = viewer.runtime;
    const before = viewer.getState();

    await expect(viewer.setState({ ...before, dataset: DESC_FAIL }))
      .rejects.toThrow(/Failed to open mem:\/\/fail/);
    expect(viewer.status).toBe("error");
    expect(viewer.runtime).toBe(runtime); // never torn down
    expect(viewer.getState()).toEqual(before);

    await viewer.setState({ ...before, dataset: DESC_OTHER });
    expect(viewer.status).toBe("ready");
    expect(viewer.dataset?.config).toEqual(DESC_OTHER);
  });

  test("a changed-dataset restore transfers ownership and cleans up", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: SPY_A });
    const first = created[0];
    const state: State = { ...viewer.getState(), dataset: SPY_B };

    await viewer.setState(state);
    const second = created[1];
    expect(viewer.dataset).toBe(second);
    expect(viewer.dataset).not.toBe(first);
    expect(first.disposeSpy).toHaveBeenCalledTimes(1); // released at the commit point
    expect(second.disposeSpy).not.toHaveBeenCalled();
    expect(viewer.getState().dataset).toEqual(SPY_B);

    viewer.destroy();
    expect(second.disposeSpy).toHaveBeenCalledTimes(1); // owned until destroy
  });

  test("GPU/mount failure after preflight leaves no partial state or leaked resources", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: SPY_A });
    const first = created[0];
    stubWebGPUMissing();

    await expect(viewer.setState({ ...viewer.getState(), dataset: SPY_B }))
      .rejects.toThrow(/WebGPU not supported/);

    expect(viewer.status).toBe("error");
    expect(viewer.runtime).toBeUndefined(); // no leaked replacement runtime
    expect(viewer.dataset).toBeUndefined(); // no partial high-level state
    const second = created[1];
    expect(first.disposeSpy).toHaveBeenCalledTimes(1); // replaced at the commit point
    expect(second.disposeSpy).toHaveBeenCalledTimes(1); // replacement disposed on failure
    expect(() => viewer.getState()).toThrow(/no committed scene/);

    // The viewer recovers from a clean slate.
    stubWebGPU();
    await viewer.open(SPY_A);
    expect(viewer.status).toBe("ready");
    expect(viewer.getState().dataset).toEqual(SPY_A);
  });

  test("rapid setState calls settle on the last state", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const volumeState = viewer.getState();
    await viewer.setComposition({ type: "slice" });
    const sliceState = viewer.getState();

    const stale = viewer.setState(volumeState);
    const fresh = viewer.setState(sliceState);
    await expect(stale).rejects.toBeInstanceOf(ViewerSupersededError);
    await fresh;

    expect(viewer.status).toBe("ready");
    expect(viewer.getState()).toEqual(sliceState);
    expect(viewer.resolvedComposition).toBe("slice");
  });

  test("setState on an idle viewer opens the declared dataset", async () => {
    const viewer = await makeViewer();
    const seeded = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const state = portable(seeded);

    await viewer.setState(state);
    expect(viewer.status).toBe("ready");
    expect(viewer.dataset?.config).toEqual(DESC_3D);
    expect(viewer.getState()).toEqual(state);

    // …but a state with no dataset and no live dataset cannot restore.
    const idle = await makeViewer();
    await expect(idle.setState({ ...state, dataset: undefined }))
      .rejects.toThrow(/state\.dataset is required/);
  });
});

// ============================================================================
// SAME-DATASET RESTORE — NO DUPLICATE METADATA OPEN (real "ome-zarr" kind)
// ============================================================================

const ZARR_URL = "https://example.test/state-me.ome.zarr";

// Minimal v3 2D store: shape [y=8, x=8], chunks [4, 4], one pyramid level.
const GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
      multiscales: [{
        axes: [
          { name: "y", type: "space" },
          { name: "x", type: "space" },
        ],
        datasets: [{
          path: "0",
          coordinateTransformations: [{ type: "scale", scale: [0.5, 0.5] }],
        }],
      }],
    },
  },
});

const ARRAY_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [8, 8],
  data_type: "uint16",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: 0,
  codecs: [{ name: "bytes", configuration: {} }],
  attributes: {},
  dimension_names: ["y", "x"],
});

describe("same-dataset restore", () => {
  const encoder = new TextEncoder();
  let metadataOpens: number;

  beforeEach(() => {
    metadataOpens = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href === `${ZARR_URL}/zarr.json`) {
        metadataOpens++;
        return new Response(encoder.encode(GROUP_JSON), { status: 200 });
      }
      if (href === `${ZARR_URL}/0/zarr.json`) {
        return new Response(encoder.encode(ARRAY_JSON), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
  });

  test("restoring an unchanged descriptor never reopens the store", async () => {
    const viewer = await makeViewer(makeHostCanvas(), {
      dataset: { type: "ome-zarr", source: ZARR_URL },
    });
    expect(viewer.dataset).toBeInstanceOf(OMEZarrDataset);
    expect(metadataOpens).toBe(1);

    const before = viewer.getState();
    await viewer.setState(before);
    expect(metadataOpens).toBe(1); // the live dataset was reused
    expect(viewer.getState()).toEqual(before);
    expect(viewer.resolvedComposition).toBe("slice"); // 2D store
  });
});

// ============================================================================
// SUBSCRIPTIONS
// ============================================================================

describe("state subscriptions", () => {
  test("one committed snapshot per rebuild; live edits do not notify", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const snapshots: State[] = [];
    viewer.subscribe((state) => snapshots.push(state));

    await viewer.setState(viewer.getState());
    expect(snapshots).toHaveLength(1); // ONE notification for the committed state
    expect(snapshots[0]).toEqual(viewer.getState());

    await viewer.setComposition({ type: "slice" });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].composition).toEqual({ type: "slice" });

    // Live interaction-level changes are read via getState(), not notified.
    viewer.channel(0).configure({ contrast: [0.1, 0.2] });
    viewer.setCamera({ position: [2, 2, 30] });
    expect(snapshots).toHaveLength(2);
  });

  test("unsubscribing stops notifications; destroy clears and rejects", async () => {
    const viewer = await makeViewer(makeHostCanvas(), { dataset: DESC_3D });
    const snapshots: State[] = [];
    const unsubscribe = viewer.subscribe((state) => snapshots.push(state));

    await viewer.setComposition({ type: "slice" });
    expect(snapshots).toHaveLength(1);
    unsubscribe();
    await viewer.setComposition({ type: "volume" });
    expect(snapshots).toHaveLength(1);

    expect(() => viewer.subscribe(null as never)).toThrow(/listener must be a function/);
    viewer.destroy();
    expect(() => viewer.subscribe(() => {})).toThrow(/destroyed/);
  });
});
