// @vitest-environment jsdom

/**
 * High-level Viewer ROI event tests (API-4): `viewer.on("roiChange" |
 * "roiActiveChange", handler)` is the typed runtime counterpart of the
 * low-level overlay callbacks.
 *
 * Covered here:
 * - one overlay change produces exactly one event, carrying the interacting
 *   view's id and the mode in effect (`{ rois, change, viewId, mode }`);
 * - subscriptions live on the Viewer and survive mode rebuilds (the
 *   forwarders re-attach to each new scene's roiselector overlays);
 * - the returned unsubscribe function stops events;
 * - `destroy()` clears subscriptions (a stale forwarder reaches no handler);
 * - the low-level engine path (`view.setOverlayOptions("roiselector", {
 *   onRoisChange })`) keeps working — the overlay has a single callback slot,
 *   so a low-level callback takes over from the Viewer forwarder until the
 *   next rebuild re-wires it.
 *
 * Harness: jsdom DOM + fake WebGPU device. rAF is stubbed, so overlay renders
 * are driven manually via `overlay.render(state)` (the same seam the
 * overlay's own tests use); pointer interaction is dispatched as DOM events.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDataset,
  type DatasetConfig,
  type DefaultLayersOptions,
  type RoiBox,
  type Viewer,
  type ViewerConfig,
  type ViewerRoiActiveChangeEvent,
  type ViewerRoiChangeEvent,
} from "../src/index";
import { RoiSelectorOverlay } from "../src/advanced";
import { datasetRegistry } from "../src/registry";
import type { ImagePyramid, LayerConfig } from "../src/types";

// ============================================================================
// STUB DATASET KIND
// ============================================================================

const KIND = "roi-events-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "roi-events-stub": { type: "roi-events-stub"; source: string };
  }
}

const PYRAMID_3D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [1, 1, 1] }],
};

const DESC: DatasetConfig = { type: KIND, source: "mem://roi" };

class StubImageDataset extends Dataset {
  pyramid: ImagePyramid = PYRAMID_3D;
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    this.physical = { spatial: { size: [8, 8, 4], unit: "µm", spacing: [1, 1, 1], origin: [0, 0, 0] } };
    this.dimensions = [{ name: "c", size: 1, labels: ["a"] }];
    this.defaultSelection = { c: 0 };
    this.channels = [{ index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true }];
    this.capabilities = { modes: ["slice", "volume", "quad"], defaultMode: "slice" };
  }

  override dispose(): void {}

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    const { view, prefix, axes, channels, projection } = options;
    return channels.map((channel) => ({
      id   : `${prefix}-c${channel.index}`,
      type : view,
      data : { pyramid: this.pyramid, fetch: this.fetch },
      render: {
        visible        : channel.visible,
        color          : channel.color,
        contrastLimits : [...channel.contrast] as [number, number],
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
// FAKE WEBGPU + CANVAS (jsdom supplies the DOM)
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

/** jsdom canvases have no WebGPU context — give every canvas a fake one. */
const realGetContext = HTMLCanvasElement.prototype.getContext;

function makeHostCanvas(): { container: HTMLDivElement; canvas: HTMLCanvasElement } {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, {
    clientWidth  : { value: 400 },
    clientHeight : { value: 300 },
  });
  container.appendChild(canvas);
  document.body.appendChild(container);
  return { container, canvas };
}

// ============================================================================
// HARNESS
// ============================================================================

const BOX_A: RoiBox = { min: [1, 1, 0], max: [3, 3, 3] };
const BOX_B: RoiBox = { min: [5, 5, 0], max: [7, 7, 3] };

let viewers: Viewer[];

beforeEach(() => {
  viewers = [];
  stubWebGPU();
  HTMLCanvasElement.prototype.getContext = (() => ({
    configure() {},
    unconfigure() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  registerDataset(KIND, (config) => new StubImageDataset(config));
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  HTMLCanvasElement.prototype.getContext = realGetContext;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function makeViewer(config: ViewerConfig): Promise<{ viewer: Viewer; container: HTMLDivElement }> {
  const { container, canvas } = makeHostCanvas();
  const viewer = await createViewer(canvas, { dataset: DESC, mode: "slice", ...config });
  viewers.push(viewer);
  return { viewer, container };
}

function roiOverlay(viewer: Viewer, viewId = "main"): RoiSelectorOverlay {
  const overlay = viewer.engine!.view(viewId).base.getOverlays()
    .find((candidate) => candidate instanceof RoiSelectorOverlay);
  expect(overlay, `roiselector overlay in view "${viewId}"`).toBeDefined();
  return overlay as RoiSelectorOverlay;
}

function renderOverlays(viewer: Viewer, viewIds: string[] = ["main"]): void {
  const state = viewer.engine!.getState();
  for (const id of viewIds) roiOverlay(viewer, id).render(state);
}

function bodiesIn(root: ParentNode): NodeListOf<Element> {
  return root.querySelectorAll("svg > g > rect:first-child");
}

function removeButtonsIn(root: ParentNode): NodeListOf<Element> {
  return root.querySelectorAll('button[aria-label="Remove selection"]');
}

// ============================================================================
// TESTS
// ============================================================================

describe("viewer ROI events (API-4)", () => {
  test("one change fires one event with view/mode identity", async () => {
    const { viewer, container } = await makeViewer({
      tools: { roi: { rois: [BOX_A, BOX_B], activeIndex: 0 } },
    });
    renderOverlays(viewer);

    const changes: ViewerRoiChangeEvent[] = [];
    const actives: ViewerRoiActiveChangeEvent[] = [];
    viewer.on("roiChange", (event) => changes.push(event));
    viewer.on("roiActiveChange", (event) => actives.push(event));

    // Activate the second box: one roiActiveChange, no roiChange.
    const bodies = bodiesIn(container);
    expect(bodies).toHaveLength(2);
    bodies[1].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(actives).toEqual([{ activeIndex: 1, viewId: "main", mode: "slice" }]);
    expect(changes).toHaveLength(0);

    // Remove the now-active second box: one committed roiChange (+ active reset).
    (removeButtonsIn(container)[1] as HTMLButtonElement).click();
    expect(changes).toEqual([{
      rois   : [BOX_A],
      change : { index: 1, kind: "remove", phase: "commit" },
      viewId : "main",
      mode   : "slice",
    }]);
    expect(actives).toEqual([
      { activeIndex: 1, viewId: "main", mode: "slice" },
      { activeIndex: null, viewId: "main", mode: "slice" },
    ]);
  });

  test("quad mode reports the interacting view id", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const viewer = await createViewer(container, {
      dataset : DESC,
      mode    : "quad",
      tools   : { roi: { rois: [BOX_A, BOX_B], activeIndex: 0 } },
    });
    viewers.push(viewer);

    renderOverlays(viewer, ["quad-xy", "quad-xz", "quad-yz"]);

    const changes: ViewerRoiChangeEvent[] = [];
    viewer.on("roiChange", (event) => changes.push(event));

    // The viewer-owned quad grid holds one overlay root per view, in view
    // order (xy, xz, yz, 3d); remove a box in the XZ slice overlay.
    const grid = container.firstElementChild!;
    const overlayRoots = grid.querySelectorAll(":scope > div");
    expect(overlayRoots.length).toBeGreaterThanOrEqual(4);
    (removeButtonsIn(overlayRoots[1] as HTMLElement)[1] as HTMLButtonElement).click();

    expect(changes).toEqual([{
      rois   : [BOX_A],
      change : { index: 1, kind: "remove", phase: "commit" },
      viewId : "quad-xz",
      mode   : "quad",
    }]);
  });

  test("subscriptions survive mode rebuilds", async () => {
    const { viewer, container } = await makeViewer({
      tools: { roi: { rois: [BOX_A, BOX_B], activeIndex: 0 } },
    });
    const changes: ViewerRoiChangeEvent[] = [];
    viewer.on("roiChange", (event) => changes.push(event));

    const before = roiOverlay(viewer);
    await viewer.setMode("volume");
    await viewer.setMode("slice");

    const after = roiOverlay(viewer);
    expect(after).not.toBe(before); // the scene really rebuilt

    renderOverlays(viewer);
    (removeButtonsIn(container)[1] as HTMLButtonElement).click();
    expect(changes).toEqual([{
      rois   : [BOX_A],
      change : { index: 1, kind: "remove", phase: "commit" },
      viewId : "main",
      mode   : "slice",
    }]);
  });

  test("the returned unsubscribe function stops events", async () => {
    const { viewer, container } = await makeViewer({
      tools: { roi: { rois: [BOX_A, BOX_B], activeIndex: 0 } },
    });
    renderOverlays(viewer);

    const changes: ViewerRoiChangeEvent[] = [];
    const unsubscribe = viewer.on("roiChange", (event) => changes.push(event));
    unsubscribe();

    (removeButtonsIn(container)[1] as HTMLButtonElement).click();
    expect(changes).toHaveLength(0);
  });

  test("destroy clears subscriptions and rejects new ones", async () => {
    const { viewer, container } = await makeViewer({
      tools: { roi: { rois: [BOX_A, BOX_B], activeIndex: 0 } },
    });
    renderOverlays(viewer);

    const changes: ViewerRoiChangeEvent[] = [];
    viewer.on("roiChange", (event) => changes.push(event));
    (removeButtonsIn(container)[1] as HTMLButtonElement).click();
    expect(changes).toHaveLength(1); // sanity: it fired before destroy

    const staleOverlay = roiOverlay(viewer);
    viewer.destroy();
    expect(() => viewer.on("roiChange", () => {})).toThrow(/destroyed/);

    // The destroyed overlay retained its forwarder — it must reach no handler.
    const forwarder = (staleOverlay as unknown as {
      onRoisChange?: (rois: RoiBox[], change: unknown) => void;
    }).onRoisChange;
    forwarder?.([], { index: 0, kind: "remove", phase: "commit" });
    expect(changes).toHaveLength(1);
  });

  test("unknown event names and non-function handlers throw", async () => {
    const { viewer } = await makeViewer({ tools: { roi: true } });
    expect(() => viewer.on("nope" as never, () => {})).toThrow(/Unknown viewer event: "nope"/);
    expect(() => viewer.on("roiChange", null as never)).toThrow(/handler must be a function/);
  });

  test("the low-level overlay callback path keeps working (single slot)", async () => {
    const { viewer, container } = await makeViewer({
      tools: { roi: { rois: [BOX_A], activeIndex: 0 } },
    });
    renderOverlays(viewer);

    // The engine escape hatch takes over the overlay's single callback slot.
    const lowLevel = vi.fn();
    viewer.engine!.view("main").setOverlayOptions("roiselector", { onRoisChange: lowLevel });

    (removeButtonsIn(container)[0] as HTMLButtonElement).click();
    expect(lowLevel).toHaveBeenCalledTimes(1);
    expect(lowLevel).toHaveBeenCalledWith([], { index: 0, kind: "remove", phase: "commit" });
  });
});
