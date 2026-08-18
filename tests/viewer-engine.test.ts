/**
 * ViewerEngine commit/notify flow tests (headless).
 *
 * `createViewerEngine` defers GPU init when no view has a canvas, so the full
 * state pipeline runs in node without WebGPU. `requestAnimationFrame` is
 * stubbed: node has no rAF, and the scheduled render is never flushed —
 * these tests exercise commit + notify, not the render pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createViewerEngine, type ViewerEngine } from "../src/viewer";
import type { ImagePyramid, State } from "../src/types";

const initialState: State = {
  layers      : [],
  exploration : {
    camera: {
      navMode  : "orbit",
      projMode : "perspective",
      position : [1.13, 0.12, 1.13],
      target   : [0.5, 0.5, 0.5],
    },
  },
};

describe("ViewerEngine commit/notify flow (headless)", () => {
  let rafQueue: Map<number, FrameRequestCallback>;
  let rafId: number;
  let engine: ViewerEngine | undefined;

  beforeEach(() => {
    rafQueue = new Map();
    rafId    = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++rafId;
      rafQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafQueue.delete(id); });
  });

  afterEach(() => {
    engine?.destroy();
    engine = undefined;
    vi.unstubAllGlobals();
  });

  test("createViewerEngine works without canvases and without WebGPU", async () => {
    engine = await createViewerEngine({
      state : initialState,
      views : { main: { type: "volume", layers: [] } },
    });
    expect(engine).toBeDefined();
    expect(engine.getViewConfig("main")?.type).toBe("volume");
    expect(rafQueue.size).toBe(0); // no render scheduled without a mount
  });

  test("getState round-trips and returns defensive clones", async () => {
    engine = await createViewerEngine({ state: initialState, views: {} });

    const a = engine.getState();
    const b = engine.getState();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.exploration.camera.position).not.toBe(b.exploration.camera.position);

    a.exploration.camera.target[0] = 99;
    expect(engine.getState().exploration.camera.target[0]).toBe(0.5);
  });

  test("subscribe fires on a state change with the committed state", async () => {
    engine = await createViewerEngine({ state: initialState, views: {} });
    const onState = vi.fn();
    engine.subscribe(onState);

    engine.setTarget([0.25, 0.5, 0.5]);

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0]![0].exploration.camera.target).toEqual([0.25, 0.5, 0.5]);
    expect(engine.getState().exploration.camera.target).toEqual([0.25, 0.5, 0.5]);
    // A commit schedules exactly one render pass (never flushed headless).
    expect(rafQueue.size).toBe(1);
  });

  test("subscribe does not fire on a no-op nav-mode switch", async () => {
    engine = await createViewerEngine({ state: initialState, views: {} });
    const onState = vi.fn();
    engine.subscribe(onState);

    engine.setNavMode("orbit"); // already orbit — early return, no commit
    expect(onState).not.toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);

    engine.setNavMode("fly");
    expect(onState).toHaveBeenCalledTimes(1);
    expect(engine.getState().exploration.camera.navMode).toBe("fly");
  });

  test("setTarget recomputes position in orbit mode and unsubscribe stops notify", async () => {
    engine = await createViewerEngine({ state: initialState, views: {} });
    const onState = vi.fn();
    const unsubscribe = engine.subscribe(onState);

    const before = engine.getState().exploration.camera.position;
    engine.setTarget([0.1, 0.2, 0.3]);
    const after = engine.getState().exploration.camera.position;
    expect(after).not.toEqual(before); // orbit mode: position recomputed around target
    expect(onState).toHaveBeenCalledTimes(1);

    unsubscribe();
    engine.setTarget([0.5, 0.5, 0.5]);
    expect(onState).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// updateLayers — ONE ATOMIC MULTI-LAYER TRANSACTION (ARCH-2)
// ============================================================================

const PYRAMID: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [1, 1, 2] }],
};
const NO_FETCH = async () => new ArrayBuffer(0);

const layerState: State = {
  layers: [
    {
      id      : "volume-c0",
      type    : "volume",
      data    : { pyramid: PYRAMID, fetch: NO_FETCH },
      render  : { visible: true, color: "#00B0FF", contrastLimits: [0, 1] },
      options : { selection: { c: 0, t: 0 }, axes: ["x", "y"] },
    },
    {
      id      : "volume-c1",
      type    : "volume",
      data    : { pyramid: PYRAMID, fetch: NO_FETCH },
      render  : { visible: false, color: "#FF3D3D", contrastLimits: [0, 1] },
      options : { selection: { c: 1, t: 0 } },
    },
  ],
  exploration: initialState.exploration,
};

describe("ViewerEngine.updateLayers (ARCH-2)", () => {
  let rafQueue: Map<number, FrameRequestCallback>;
  let rafId: number;
  let engine: ViewerEngine | undefined;

  beforeEach(() => {
    rafQueue = new Map();
    rafId    = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++rafId;
      rafQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafQueue.delete(id); });
  });

  afterEach(() => {
    engine?.destroy();
    engine = undefined;
    vi.unstubAllGlobals();
  });

  test("one batch is one commit: one subscriber notification, one scheduled render", async () => {
    engine = await createViewerEngine({ state: layerState, views: {} });
    const onState = vi.fn();
    engine.subscribe(onState);

    engine.updateLayers([
      {
        id      : "volume-c0",
        options : { selection: { c: 1 } },
        render  : { color: "#FFFFFF", contrastLimits: [0.2, 0.8] },
      },
      { id: "volume-c1", render: { visible: true } },
    ]);

    expect(onState).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);

    const [first, second] = engine.getState().layers;
    // options merge per key with nested-object semantics (same as setOptions):
    // selection merges, sibling keys survive; array values replace wholesale.
    expect(first.options?.selection).toEqual({ c: 1, t: 0 });
    expect(first.options?.axes).toEqual(["x", "y"]);
    // render merges shallowly; untouched keys survive.
    expect(first.render).toMatchObject({
      visible: true, color: "#FFFFFF", contrastLimits: [0.2, 0.8],
    });
    expect(second.render?.visible).toBe(true);
    expect(second.render?.color).toBe("#FF3D3D");
  });

  test("an unknown id fails the whole batch atomically, naming the id", async () => {
    engine = await createViewerEngine({ state: layerState, views: {} });
    const onState = vi.fn();
    engine.subscribe(onState);
    const before = engine.getState();

    expect(() => engine!.updateLayers([
      { id: "volume-c0", render: { color: "#000000" } },
      { id: "nope", render: { visible: true } },
    ])).toThrow(/unknown layer id "nope"/);

    // State left completely unchanged — no commit, no notify, no render.
    expect(engine.getState()).toEqual(before);
    expect(onState).not.toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });

  test("an empty patch list is a no-op", async () => {
    engine = await createViewerEngine({ state: layerState, views: {} });
    const onState = vi.fn();
    engine.subscribe(onState);

    engine.updateLayers([]);

    expect(onState).not.toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });

  test("data merges shallowly across the batch", async () => {
    engine = await createViewerEngine({ state: layerState, views: {} });
    engine.updateLayers([{ id: "volume-c0", data: { url: "mem://other" } }]);
    const layer = engine.getState().layers[0];
    expect(layer.data?.url).toBe("mem://other");
    expect(layer.data?.pyramid).toBe(PYRAMID); // untouched data keys survive
  });

  test("single setters behave as before through the same patch logic", async () => {
    engine = await createViewerEngine({ state: layerState, views: {} });
    const onState = vi.fn();
    engine.subscribe(onState);

    // One setter call = one commit.
    engine.layer("volume-c0")!.setOptions({ selection: { c: 1 } });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);
    expect(engine.getState().layers[0].options?.selection).toEqual({ c: 1, t: 0 });

    engine.layer("volume-c0")!.setRender({ visible: false });
    expect(onState).toHaveBeenCalledTimes(2);
    expect(engine.getState().layers[0].render?.visible).toBe(false);
    expect(engine.getState().layers[0].render?.color).toBe("#00B0FF");

    engine.layer("volume-c0")!.setData({ url: "mem://x" });
    expect(onState).toHaveBeenCalledTimes(3);
    expect(engine.getState().layers[0].data?.url).toBe("mem://x");
    expect(engine.getState().layers[0].data?.pyramid).toBe(PYRAMID);

    // Array-valued option keys replace, never merge.
    engine.layer("volume-c0")!.setOptions({ axes: ["x", "z"] });
    expect(engine.getState().layers[0].options?.axes).toEqual(["x", "z"]);
  });
});
