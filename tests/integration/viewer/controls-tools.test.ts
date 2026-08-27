/**
 * Viewer controls/tools integration tests: declarative and imperative
 * control/tool configuration stay in runtime parity with the live control
 * chain and overlay set — headless via the shared integration/viewer harness
 * (stub dataset kind + fake WebGPU/canvas).
 */
import { describe, expect, test } from "vitest";
import {
  DESC_3D,
  controlTypes,
  liveOverlays,
  makeFakeCanvas,
  makeViewer,
  overlayKeys,
  setupViewerHarness,
} from "./harness";

setupViewerHarness();

// ============================================================================
// CONTROLS + TOOLS
// ============================================================================

describe("controls and tools runtime parity", () => {
  test("declarative controls land in the view config; defaults follow the mode", async () => {
    const custom = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      controls: { orbit: { zoomSensitivity: 1.4 } },
    });
    expect(custom.runtime!.getViewConfig("main")?.controls).toEqual({ orbit: { zoomSensitivity: 1.4 } });

    const off = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, controls: {} });
    expect(off.runtime!.getViewConfig("main")?.controls).toEqual({});
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
    await viewer.setComposition({ type: "slice" });
    expect(controlTypes(viewer)).toEqual(["fly"]);

    expect(() => viewer.control("warp" as never)).toThrow(/Unknown control/);
  });

  test("declarative tools expand to typed overlay configs", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      tools: { crosshair: true, ruler: { visible: false }, magnifier: "2d" },
    });
    expect(viewer.runtime!.getViewConfig("main")?.overlays).toEqual({
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
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, composition: { type: "slice" } });
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
    await viewer.setComposition({ type: "volume" });
    expect(viewer.runtime!.getViewConfig("main")?.overlays).toMatchObject({
      crosshair: {},
      "magnifier-2d": {},
    });

    expect(() => viewer.tool("laser" as never)).toThrow(/Unknown tool/);
  });

  test("magnifier dimension defaults to the view kind when unpinned", async () => {
    const volumeViewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, tools: { magnifier: {} } });
    expect(volumeViewer.runtime!.getViewConfig("main")?.overlays).toEqual({ "magnifier-3d": {} });

    const sliceViewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      composition: { type: "slice" },
      tools: { magnifier: { zoom: 6 } },
    });
    expect(sliceViewer.runtime!.getViewConfig("main")?.overlays).toEqual({ "magnifier-2d": { zoom: 6 } });

    // A bare `true` is outside the schema (a dimension pin or options bag is required).
    await expect(
      makeViewer(makeFakeCanvas(), { dataset: DESC_3D, tools: { magnifier: true as never } }),
    ).rejects.toThrow(/tools\.magnifier/);
  });
});
