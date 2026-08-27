// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUI_THEME,
  MagnifierOverlay,
  type ImagePyramid,
  type LayerConfig,
  type State,
} from "../../../src/index";
import { overlayRegistry } from "../../../src/registry";
import { ensureBuiltInOverlays } from "../../../src/primitives/overlay";

const pyramid: ImagePyramid = {
  levels: [
    { path: "0", shape: [400, 300, 100], chunkSize: [16, 16, 16], scale: [1, 1, 1] },
    { path: "1", shape: [200, 150, 50], chunkSize: [16, 16, 16], scale: [2, 2, 2] },
  ],
};
const fetchTile = () => Promise.resolve(new ArrayBuffer(16 * 16 * 16 * 2));

function makeLayers(): LayerConfig[] {
  return [
    {
      id: "slice:c0",
      type: "slice",
      data: { pyramid, fetch: fetchTile },
      options: { axes: [0, 1], sliceIndex: 50, selection: { c: 0 } },
      render: { visible: true, color: "#FF0000", contrastLimits: [0.1, 0.6], blending: "additive" },
    },
    {
      id: "slice:c1",
      type: "slice",
      data: { pyramid, fetch: fetchTile },
      options: { axes: [0, 1], sliceIndex: 50, selection: { c: 1 } },
      render: { visible: false, color: "#00FF00", contrastLimits: [0.2, 0.8], blending: "additive" },
    },
  ];
}

function makeState(distance = 300): State {
  return {
    physical: {
      spatial: { origin: [0, 0, 0], size: [400, 300, 100], unit: "µm" },
      channels: { names: ["Red", "Green"] },
    },
    layers: makeLayers(),
    exploration: {
      camera: {
        navMode: "fly",
        projMode: "orthographic",
        position: [200, 150, 50 + distance],
        target: [200, 150, 50],
      },
    },
  };
}

function cloneState(state: State): State {
  return {
    physical: state.physical ? structuredClone(state.physical) : undefined,
    layers: state.layers!.map((layer) => ({
      ...layer,
      data: layer.data ? { ...layer.data } : undefined,
      options: layer.options ? structuredClone(layer.options) : undefined,
      render: layer.render ? structuredClone(layer.render) : undefined,
    })),
    exploration: structuredClone(state.exploration),
  };
}

function fakeNested(initial: State, resolution = { level: 0, targetLevel: 0, refining: false }) {
  let state = cloneState(initial);
  const destroy = vi.fn();
  const setRender = vi.fn((partial: Record<string, unknown>) => {
    const target = state.layers!.find((layer) => layer.id === "slice:c0");
    if (target) target.render = { ...(target.render ?? {}), ...partial };
  });
  return {
    instance: {
      getState: () => cloneState(state),
      setState: (next: State) => { state = next; },
      requestRender: vi.fn(),
      destroy,
      layer: () => ({ setRender }),
      view: () => ({ getResolution: () => ({
        ...resolution,
        sourceUnitsPerPixel: 1,
        viewportUnitsPerPixel: 1,
        unitsPerPixel: 1,
      }) }),
    },
    getState: () => state,
    destroy,
    setRender,
  };
}

describe("MagnifierOverlay", () => {
  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    canvas = document.createElement("canvas");
    Object.defineProperties(canvas, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
    });
    host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 400 });
    host.appendChild(canvas);
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(dimension: "2d" | "3d", state = makeState()): MagnifierOverlay {
    const overlay = new MagnifierOverlay(dimension);
    overlay.bindView({
      getViewType: () => "slice",
      getLayerIds: () => state.layers!.map((layer) => layer.id),
      getCanvas: () => canvas,
      isActive: () => true,
      getAxisMap: () => [0, 1, 2] as const,
      getTheme: () => FUI_THEME,
      getOwner: () => undefined,
    });
    overlay.setOptions({ position: [200, 150, 50], size: 100, zoom: 4 });
    overlay.mount(host);
    return overlay;
  }

  /** The 3D variant mounts its root on the document body (stacking escape). */
  function mountedRoot(dimension: "2d" | "3d"): HTMLDivElement {
    return (dimension === "3d"
      ? document.body.lastElementChild
      : host.children[1]) as HTMLDivElement;
  }

  it("registers only the two explicit variants", () => {
    ensureBuiltInOverlays();
    expect((overlayRegistry.resolve("magnifier-2d")() as any).dimension).toBe("2d");
    expect((overlayRegistry.resolve("magnifier-3d")() as any).dimension).toBe("3d");
    expect(() => overlayRegistry.resolve("magnifier")).toThrow();
  });

  it("restores the original dynamic 2D pixel footprint", () => {
    const overlay = mount("2d");
    overlay.render(makeState(300));
    const root = host.children[1] as HTMLDivElement;
    const indicator = root.querySelector("rect")!;
    expect(Number(indicator.getAttribute("width"))).toBeCloseTo(25);
    expect(Number(indicator.getAttribute("height"))).toBeCloseTo(25);

    overlay.setOptions({ zoom: 2 });
    overlay.render(makeState(150));
    expect(Number(indicator.getAttribute("width"))).toBeCloseTo(50);
    expect(Number(indicator.getAttribute("height"))).toBeCloseTo(50);
    overlay.unmount();
  });

  it("keeps 2D layers free of physical-region and forced-level options", () => {
    const state = makeState();
    const overlay = mount("2d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });

    overlay.render(state);

    const wrapped = nested.getState().layers![0];
    expect(wrapped.type).toBe("slice");
    expect(wrapped.options).toMatchObject({
      selection: { c: 0 },
    });
    expect(wrapped.options?.region).toBeUndefined();
    expect(wrapped.options?.finestLevel).toBeUndefined();
    expect(wrapped.render).toMatchObject({ color: "#FF0000", contrastLimits: [0.1, 0.6] });
    overlay.unmount();
  });

  it("restores the original parent-derived 2D follow camera", () => {
    const state = makeState(300);
    const overlay = mount("2d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });

    overlay.render(state);

    expect(nested.getState().exploration.camera.target).toEqual([200, 150, 50]);
    expect(nested.getState().exploration.camera.position).toEqual([200, 150, 75]);
    overlay.unmount();
  });

  it("keeps 2D channel state synchronized with the parent", () => {
    const state = makeState();
    const overlay = mount("2d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });
    overlay.render(state);

    const next = makeState();
    next.layers![0].options = { ...next.layers![0].options, selection: { c: 1 } };
    next.layers![0].render = { visible: true, color: "#0000FF", contrastLimits: [0.3, 0.9] };
    overlay.render(next);

    expect(nested.getState().layers![0]).toMatchObject({
      options: { selection: { c: 1 } },
      render: { visible: true, color: "#0000FF", contrastLimits: [0.3, 0.9] },
    });
    overlay.unmount();
  });

  it("converts selected 3D layers to cropped MIP volume layers", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });

    overlay.render(state);

    const wrapped = nested.getState().layers![0];
    expect(wrapped.type).toBe("volume");
    expect(wrapped.data?.pyramid).toBe(pyramid);
    expect(wrapped.options).toMatchObject({
      finestLevel: true,
      region: {
        min: [184 / 400, 134 / 300, 34 / 100],
        max: [216 / 400, 166 / 300, 66 / 100],
      },
    });
    expect(wrapped.render).toMatchObject({ volumeProjection: "mip", contrastLimits: [0.1, 0.6] });
    overlay.unmount();
  });

  it("honors a configured 3D voxel extent", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    overlay.setOptions({ voxelExtent3d: 16 });
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });

    overlay.render(state);

    const readout = mountedRoot("3d").querySelector<HTMLElement>('[data-magnifier-size]')!;
    expect(readout.textContent).toBe("16 vx");
    expect(nested.getState().layers![0].options).toMatchObject({
      region: {
        min: [192 / 400, 142 / 300, 42 / 100],
        max: [208 / 400, 158 / 300, 58 / 100],
      },
    });
    overlay.unmount();
  });

  it("steps 3D extent through 16, 32, and 64 without recreating the nested view", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state, { level: 1, targetLevel: 0, refining: true });
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });
    overlay.render(state);
    const root = mountedRoot("3d");
    const decrement = root.querySelector<HTMLButtonElement>('[aria-label="Decrease 3D block size"]')!;
    const increment = root.querySelector<HTMLButtonElement>('[aria-label="Increase 3D block size"]')!;
    const readout = root.querySelector<HTMLElement>('[data-magnifier-size]')!;
    const loading = root.querySelector<HTMLElement>('[role="status"]')!;

    expect(readout.textContent).toBe("32 vx");
    decrement.click();
    expect(readout.textContent).toBe("16 vx");
    expect((overlay as any).opts.voxelExtent3d).toBe(16);
    expect(nested.destroy).not.toHaveBeenCalled();
    expect(loading.style.display).toBe("block");

    increment.click();
    increment.click();
    expect(readout.textContent).toBe("64 vx");
    expect((overlay as any).opts.voxelExtent3d).toBe(64);
    expect(nested.destroy).not.toHaveBeenCalled();
    overlay.render(state);
    expect(nested.getState().layers![0].options).toMatchObject({
      region: {
        min: [168 / 400, 118 / 300, 18 / 100],
        max: [232 / 400, 182 / 300, 82 / 100],
      },
    });
    overlay.unmount();
  });

  it("preserves the 3D camera direction when a pinned position changes", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });
    overlay.render(state);
    nested.getState().exploration.camera.position = [220, 150, 70];
    nested.getState().exploration.camera.target = [200, 150, 50];

    overlay.setOptions({ position: [240, 150, 50] });
    overlay.render(state);

    const camera = nested.getState().exploration.camera;
    expect(camera.navMode).toBe("orbit");
    expect(camera.projMode).toBe("perspective");
    expect(camera.target[0]).toBeCloseTo(240);
    expect(camera.position[0] - camera.target[0]).toBeCloseTo(camera.position[2] - camera.target[2]);
    overlay.unmount();
  });

  it("builds local per-channel controls without mutating parent state", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });
    overlay.render(state);
    (overlay as any).rebuildChannelPanel(state, (overlay as any).prepare3d(state));

    const root = mountedRoot("3d");
    const channels = root.querySelectorAll<HTMLElement>('[data-magnifier-channel]');
    const sliders = root.querySelectorAll<HTMLElement>('.range-slider');
    const thumbs = root.querySelectorAll<HTMLButtonElement>('.range-thumb');
    const visibility = root.querySelector<HTMLButtonElement>('[aria-label="Hide Red"]')!;
    expect(channels).toHaveLength(2);
    expect(sliders).toHaveLength(2);
    expect(thumbs).toHaveLength(4);
    visibility.click();

    expect(nested.setRender).toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    Object.defineProperty(sliders[0], "getBoundingClientRect", {
      value: () => ({ left: 0, width: 100, top: 0, right: 100, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => ({}) }),
    });
    thumbs[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 60 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(nested.setRender).toHaveBeenCalledWith(expect.objectContaining({ contrastLimits: expect.any(Array) }));
    expect(state.layers![0].render?.visible).toBe(true);
    overlay.unmount();
  });

  it("folds the channel panel into a tab attached to the overlay side", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });
    overlay.render(state);
    (overlay as any).rebuildChannelPanel(state, (overlay as any).prepare3d(state));
    const root = mountedRoot("3d");
    const tab = root.querySelector<HTMLButtonElement>('[aria-label="Collapse channels"]')!;
    const panel = root.querySelector<HTMLElement>('[data-magnifier-channel-panel]')!;

    expect(tab).toBeTruthy();
    expect(panel.style.display).toBe("block");
    tab.click();
    expect(tab.getAttribute("aria-label")).toBe("Expand channels");
    expect(panel.style.display).toBe("none");
    expect((overlay as any).nested).toBe(nested.instance);
    tab.click();
    expect(panel.style.display).toBe("block");
    overlay.unmount();
  });

  it("shows a loading badge until target level 0 is fully resident", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state, { level: 1, targetLevel: 0, refining: true });
    Object.assign(overlay, { nested: nested.instance, mountedLayerIds: state.layers!.map((layer) => layer.id) });
    overlay.render(state);
    const loading = mountedRoot("3d").querySelector<HTMLElement>('[role="status"]')!;
    expect(loading.style.display).toBe("block");
    overlay.unmount();
  });

  it("pauses 3D spin during interaction and resumes after one second", () => {
    vi.useFakeTimers();
    const requestFrame = vi.fn(() => 17);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, {
      nested: nested.instance,
      mountedLayerIds: state.layers!.map((layer) => layer.id),
      renderActive: true,
    });
    (overlay as any).pauseSpin();
    expect((overlay as any).spinPaused).toBe(true);
    (overlay as any).scheduleSpinResume();
    vi.advanceTimersByTime(999);
    expect((overlay as any).spinPaused).toBe(true);
    vi.advanceTimersByTime(1);
    expect((overlay as any).spinPaused).toBe(false);
    expect(requestFrame).toHaveBeenCalled();
    overlay.unmount();
  });

  it("applies the base zIndex option to the overlay root (default 10)", () => {
    const overlay = mount("3d");
    const root = mountedRoot("3d");
    expect(root.style.zIndex).toBe("10");

    // App chrome floating above the viewer (e.g. z-index 20 HUD panels) would
    // otherwise event-occlude the magnifier's interactive channel panel.
    overlay.setOptions({ zIndex: 40 });
    expect(root.style.zIndex).toBe("40");
    overlay.unmount();

    // A value set before mount survives the mount.
    const early = new MagnifierOverlay("3d");
    early.bindView({
      getViewType: () => "slice",
      getLayerIds: () => [],
      getCanvas: () => canvas,
      isActive: () => true,
      getAxisMap: () => [0, 1, 2] as const,
      getTheme: () => FUI_THEME,
      getOwner: () => undefined,
    });
    early.setOptions({ zIndex: 40 });
    early.mount(host);
    expect((document.body.lastElementChild as HTMLDivElement).style.zIndex).toBe("40");
    early.unmount();
  });

  it("destroys nested rendering and clears the pin when disabled", () => {
    const state = makeState();
    const overlay = mount("3d", state);
    const nested = fakeNested(state);
    Object.assign(overlay, { nested: nested.instance });

    overlay.setOptions({ visible: false });

    expect(nested.destroy).toHaveBeenCalledOnce();
    expect((overlay as any).opts.position).toBeNull();
    expect((overlay as any).nested).toBeUndefined();
    overlay.unmount();
  });
});