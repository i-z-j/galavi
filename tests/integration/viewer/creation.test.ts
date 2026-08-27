/**
 * Viewer creation integration tests: target resolution, open translation to
 * the low-level scene model (§15.5), open status/failure/supersession
 *, camera, serialization, escape hatch + teardown, and viewer-local
 * presentation prefs (theme / autoRotate) — headless via the shared
 * integration/viewer harness (stub dataset kind + fake WebGPU/canvas).
 */
import { describe, expect, test, vi } from "vitest";
import { createViewer, ViewerRuntime, ViewerSupersededError, type ViewerConfig } from "../../../src/index";
import {
  DESC_3D,
  DESC_2D,
  DESC_ALL_ACTIVE,
  DESC_FAIL,
  DESC_OTHER,
  DESC_STRIDED,
  layerOf,
  makeFakeCanvas,
  makeFakeContainer,
  makeViewer,
  setupViewerHarness,
} from "./harness";

setupViewerHarness();

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
    const runtime = viewer.runtime!;
    expect(runtime).toBeInstanceOf(ViewerRuntime);
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedComposition).toBe("volume");
    // Canvas target: the dataset's modes minus quad (it needs a container).
    expect(viewer.availableCompositions).toEqual(["slice", "volume"]);
    expect(viewer.dataset?.config).toEqual(DESC_3D);

    const state = runtime.getState();
    // Physical comes from the resolved dataset, with channel names promoted.
    expect(state.physical?.spatial.size).toEqual([4, 4, 8]);
    expect(state.physical?.spatial.unit).toBe("μm");
    expect(state.physical?.channels?.names).toEqual(["a", "b"]);

    // One typed volume layer per channel, nested options.selection.c.
    expect(state.layers!.map((l) => l.id)).toEqual(["volume-c0", "volume-c1"]);
    for (const [i, layer] of state.layers!.entries()) {
      expect(layer.type).toBe("volume");
      expect(layer.options?.selection).toEqual({ c: i });
      expect(layer.options).not.toHaveProperty("maxPoolSize"); // the tile-budget policy owns budgets
      expect(layer.render?.volumeProjection).toBe("mip");
    }
    // Channel visibility defaults come from the dataset (active flags respected).
    expect(state.layers![0].render).toMatchObject({ visible: true, color: "#00B0FF", contrastLimits: [0, 1] });
    expect(state.layers![1].render).toMatchObject({ visible: false, color: "#FF3D3D" });

    // The view binds the canvas, the layer ids, and the mode-default control.
    const view = runtime.getViewConfig("main")!;
    expect(view.type).toBe("volume");
    expect(view.layers).toEqual(["volume-c0", "volume-c1"]);
    expect(view.controls).toEqual({ orbit: {} });
    expect(view.overlays).toEqual({});

    // Fit camera frames the dataset bounds (center of the physical box).
    expect(runtime.getState().exploration.camera.target).toEqual([2, 2, 4]);
  });

  test("2D dataset in auto mode → slice view and slice layers", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_2D });
    expect(viewer.resolvedComposition).toBe("slice");
    expect(viewer.availableCompositions).toEqual(["slice"]);

    const state = viewer.runtime!.getState();
    expect(state.layers!.map((l) => l.id)).toEqual(["slice-c0", "slice-c1"]);
    expect(state.layers![0].type).toBe("slice");
    expect(state.layers![0].options?.selection).toEqual({ c: 0 });
    expect(state.layers![0].render?.volumeProjection).toBeUndefined();

    const view = viewer.runtime!.getViewConfig("main")!;
    expect(view.type).toBe("slice");
    expect(view.controls).toEqual({ panzoom: {} });

    const camera = state.exploration.camera;
    expect(camera.navMode).toBe("fly");
    expect(camera.projMode).toBe("orthographic");
    expect(camera.target).toEqual([2, 2, 4]);
  });

  test("z-chunk=1 pyramid in auto mode → volume via the bounded-preview policy", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_STRIDED });
    expect(viewer.resolvedComposition).toBe("volume");
    const layer = layerOf(viewer, "volume-c0");
    expect(layer.options).not.toHaveProperty("maxPoolSize");
  });

  test("explicit mode wins over auto resolution", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, composition: { type: "slice" } });
    expect(viewer.resolvedComposition).toBe("slice");
    expect(viewer.runtime!.getViewConfig("main")?.type).toBe("slice");
    expect(layerOf(viewer, "slice-c0").type).toBe("slice");
  });

  test("OMERO-active-style all-visible channels are respected", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_ALL_ACTIVE });
    expect(layerOf(viewer, "volume-c0").render?.visible).toBe(true);
    expect(layerOf(viewer, "volume-c1").render?.visible).toBe(true);
  });
});

// ============================================================================
// OPEN STATUS / FAILURE / SUPERSESSION
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
    expect(viewer.resolvedComposition).toBe("volume");
    expect(viewer.runtime!.getViewConfig("main")?.type).toBe("volume");
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
// CAMERA
// ============================================================================

describe("camera", () => {
  test('config camera "fit" uses the dataset bounds; partials merge over fit', async () => {
    const fit = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(fit.runtime!.getState().exploration.camera.target).toEqual([2, 2, 4]);

    const partial = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      camera: { target: [1, 1, 1], projMode: "orthographic" },
    });
    const cam = partial.runtime!.getState().exploration.camera;
    expect(cam.target).toEqual([1, 1, 1]);
    expect(cam.projMode).toBe("orthographic");
    expect(cam.navMode).toBe("orbit"); // fit default preserved
  });

  test("setCamera merges over the current camera; fitCamera reframes", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.setCamera({ target: [3, 3, 3] });
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([3, 3, 3]);
    viewer.setCamera("fit");
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([2, 2, 4]);
    viewer.setCamera({ target: [0, 0, 0] });
    viewer.fitCamera();
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([2, 2, 4]);
  });
});

// ============================================================================
// SERIALIZATION
// ============================================================================

describe("serialization", () => {
  test("ViewerConfig is JSON-serializable and normalizes into getState()", async () => {
    const config: ViewerConfig = {
      dataset: DESC_3D,
      composition: "auto",
      channels: [{ index: 1, visible: true, color: "#00FF00", contrast: [0.2, 0.8] }],
      projection: "minip",
      camera: "fit",
      controls: { orbit: { zoomSensitivity: 1.4 } },
      tools: { crosshair: true, magnifier: "3d" },
      compositions: { slice: { channels: [{ index: 0, contrast: [0, 0.5] }] } },
    };
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);

    const viewer = await makeViewer(makeFakeCanvas(), config);
    const emitted = viewer.getState();
    // State is the normalized output document: pure JSON, resolved
    // composition reference, fully resolved channels, a concrete live camera
    // (never "fit"/"auto").
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(emitted);
    expect(emitted.dataset).toEqual(DESC_3D);
    expect(emitted.composition).toEqual({ type: "volume" });
    expect(emitted.channels).toHaveLength(2);
    expect(emitted.channels![1]).toEqual({
      index: 1, label: "b", visible: true, color: "#00FF00", contrast: [0.2, 0.8],
    });
    expect(emitted.projection).toBe("minip");
    expect(emitted.exploration.camera.target).toEqual([2, 2, 4]);
    // Facade documents omit layers — the composition re-derives them.
    expect(emitted.layers).toBeUndefined();
    // Per-composition overrides round-trip under `compositions`.
    expect(emitted.compositions).toEqual({ slice: { channels: [{ index: 0, contrast: [0, 0.5] }] } });
  });

  test("getState() reflects imperative changes (parity mirror)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.channel(1).configure({ visible: true, contrast: [0.1, 0.2] });
    viewer.projection = "mean";
    const emitted = viewer.getState();
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
  test("viewer.runtime exposes the low-level instance; replaced on transitions", async () => {
    const viewer = await makeViewer();
    expect(viewer.runtime).toBeUndefined();
    await viewer.open(DESC_3D);
    const first = viewer.runtime;
    expect(first).toBeInstanceOf(ViewerRuntime);
    await viewer.setComposition({ type: "slice" });
    expect(viewer.runtime).toBeInstanceOf(ViewerRuntime);
    expect(viewer.runtime).not.toBe(first);
  });

  test("destroy tears down; further operations reject", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.destroy();
    expect(viewer.runtime).toBeUndefined();
    expect(viewer.status).toBe("idle");
    await expect(viewer.open(DESC_3D)).rejects.toThrow(/destroyed/);
    await expect(viewer.setComposition({ type: "slice" })).rejects.toThrow(/destroyed/);
    viewer.destroy(); // idempotent
  });
});

// ============================================================================
// SITE-CHROME PASS-THROUGH (theme / autoRotate) + CHANNEL COMPOSITING
// ============================================================================

describe("theme, autoRotate, and channel compositing", () => {
  test("config.theme is forwarded to createViewerRuntime (overlays resolve it)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      theme: { accent: "#123456" },
    });
    expect(viewer.runtime!.theme.accent).toBe("#123456");
    // Untouched fields fall back to the default theme.
    expect(viewer.runtime!.theme.warn).toBe("#FFC966");
    // Theme is a viewer-local presentation preference: NOT part of the
    // portable State (it stays in ViewerConfig).
    expect(viewer.getState()).not.toHaveProperty("theme");
  });

  test("config.autoRotate lands on volume view configs only", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      autoRotate: { speedDegPerSec: 8 },
    });
    expect(viewer.runtime!.getViewConfig("main")?.autoRotate).toEqual({ speedDegPerSec: 8 });
    await viewer.setComposition({ type: "slice" });
    expect(viewer.runtime!.getViewConfig("main")?.autoRotate).toBeUndefined();
  });

  test("autoRotate is off by default and validates its options bag", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(viewer.runtime!.getViewConfig("main")?.autoRotate).toBeUndefined();
    await expect(
      makeViewer(makeFakeCanvas(), { autoRotate: { speedDegPerSec: Number.NaN } }),
    ).rejects.toThrow(/autoRotate\.speedDegPerSec/);
  });

  test("generated channel layers composite additively (multichannel default)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(layerOf(viewer, "volume-c0").render?.blending).toBe("additive");
    expect(layerOf(viewer, "volume-c1").render?.blending).toBe("additive");
    await viewer.setComposition({ type: "slice" });
    expect(layerOf(viewer, "slice-c0").render?.blending).toBe("additive");
  });
});
