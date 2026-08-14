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
import type { State } from "../src/types";

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
