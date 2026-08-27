/**
 * Viewer composition-switching integration tests: composition
 * transitions (focus preservation, last-write-wins, idle intent), composition
 * support (dataset resources ∩ target layout), slice navigation, the quad
 * composition's layout, and per-composition overrides — headless via the
 * shared integration/viewer harness (stub dataset kind + fake WebGPU/canvas).
 */
import { describe, expect, test, vi } from "vitest";
import { MeshDataset, ViewerSupersededError } from "../../../src/index";
import {
  DESC_2D,
  DESC_3D,
  DESC_UNSUPPORTED,
  compositionOverridesOf,
  layerOf,
  makeFakeCanvas,
  makeFakeContainer,
  makeViewer,
  setupViewerHarness,
} from "./harness";

setupViewerHarness();

// ============================================================================
// COMPOSITION TRANSITIONS
// ============================================================================

describe("composition transitions", () => {
  test("slice ↔ volume preserves the physical focus", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // auto → volume
    viewer.runtime!.setTarget([1, 2, 3]);

    await viewer.setComposition({ type: "slice" });
    expect(viewer.resolvedComposition).toBe("slice");
    expect(viewer.runtime!.getViewConfig("main")?.type).toBe("slice");
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([1, 2, 3]);

    await viewer.setComposition({ type: "volume" });
    expect(viewer.resolvedComposition).toBe("volume");
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([1, 2, 3]);
  });

  test("rapid flips are last-write-wins and settle on the final composition", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // volume
    const first = viewer.setComposition({ type: "slice" });
    const second = viewer.setComposition({ type: "volume" });
    const third = viewer.setComposition({ type: "slice" });
    // The superseded transitions reject with ViewerSupersededError…
    await expect(first).rejects.toBeInstanceOf(ViewerSupersededError);
    await expect(second).rejects.toBeInstanceOf(ViewerSupersededError);
    // …and the latest call wins, resolving once the final scene is ready.
    await third;
    expect(viewer.resolvedComposition).toBe("slice");
    expect(viewer.status).toBe("ready");
    expect(viewer.runtime!.getViewConfig("main")?.type).toBe("slice");
    expect(layerOf(viewer, "slice-c0").type).toBe("slice");
    await viewer.ready;
  });

  test("setComposition on an idle viewer records intent, applied at open", async () => {
    const viewer = await makeViewer();
    await viewer.setComposition({ type: "slice" }); // resolves immediately — nothing to rebuild
    expect(viewer.resolvedComposition).toBeUndefined(); // not yet resolved
    await viewer.open(DESC_3D);
    expect(viewer.resolvedComposition).toBe("slice");
  });

  test("setComposition on an idle viewer defers validation to open", async () => {
    const viewer = await makeViewer(); // idle, canvas target
    await viewer.setComposition({ type: "quad" }); // intent recorded — not validated yet
    await expect(viewer.open(DESC_3D)).rejects.toThrow(/quad.*requires a container element/);
    expect(viewer.status).toBe("error");
  });

  test("setComposition to the current composition is an in-place no-op", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // volume
    const runtime = viewer.runtime;
    await viewer.setComposition({ type: "volume" });
    expect(viewer.runtime).toBe(runtime); // no rebuild
    expect(viewer.status).toBe("ready");
  });

  test("an invalid selection rejects the transition", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    await expect(viewer.setComposition(42 as never)).rejects.toThrow(
      /composition must be "auto", a \{ type, config\? \} reference/,
    );
    // "auto" is never a reference type.
    await expect(viewer.setComposition({ type: "auto" })).rejects.toThrow(/"auto"/);
    // An unknown type rejects with the registry error, pre-teardown.
    const runtime = viewer.runtime;
    await expect(viewer.setComposition({ type: "nope" })).rejects.toThrow(
      /Unknown composition type: "nope"/,
    );
    expect(viewer.runtime).toBe(runtime);
  });
});

// ============================================================================
// COMPOSITION SUPPORT (dataset resources ∩ target layout)
// ============================================================================

describe("composition support", () => {
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

  test('`composition: "auto"` resolves from the primary resource (2D → slice, 3D → volume)', async () => {
    const image2d = await makeViewer(makeFakeCanvas(), { dataset: DESC_2D });
    expect(image2d.resolvedComposition).toBe("slice");
    expect(image2d.availableCompositions).toEqual(["slice"]);

    const image3d = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(image3d.resolvedComposition).toBe("volume");
  });

  test("an unsupported explicit composition rejects the open with an actionable error", async () => {
    await expect(makeViewer(makeFakeCanvas(), { dataset: DESC_2D, composition: { type: "volume" } })).rejects.toThrow(
      /Composition "volume" is not supported by dataset kind "viewer-stub" \(available: slice, grid\)/,
    );
  });

  test("an unsupported composition rejects before any teardown", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_2D });
    expect(viewer.resolvedComposition).toBe("slice");
    const runtime = viewer.runtime;

    await expect(viewer.setComposition({ type: "volume" })).rejects.toThrow(
      /Composition "volume" is not supported by dataset kind "viewer-stub" \(available: slice, grid\)/,
    );
    // The rejected transition left the running scene untouched.
    expect(viewer.runtime).toBe(runtime);
    expect(viewer.resolvedComposition).toBe("slice");
    expect(viewer.status).toBe("ready");
    await viewer.ready;
  });

  test("a dataset no registered composition supports gets an actionable error pointing at the extension points", async () => {
    const viewer = await makeViewer();
    await expect(viewer.open(DESC_UNSUPPORTED)).rejects.toThrow(
      /No registered composition supports dataset kind "viewer-stub" \(resources: "viewer-stub-custom" "weird"\).*registerComposition\(\).*createViewerRuntime/,
    );
    expect(viewer.status).toBe("error");
    // The dataset stays open and owned: no high-level composition, but the
    // advanced path (createViewerRuntime) can still compose its resources.
    expect(viewer.dataset).toBeDefined();
    expect(viewer.availableCompositions).toEqual([]);
    await expect(viewer.setComposition({ type: "slice" })).rejects.toThrow(
      /No registered composition supports dataset kind "viewer-stub"/,
    );
  });

  test("a canvas target excludes multi-view compositions from the available list", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(viewer.availableCompositions).toEqual(["slice", "volume"]);

    const runtime = viewer.runtime;
    await expect(viewer.setComposition({ type: "quad" })).rejects.toThrow(/quad.*requires a container element/);
    expect(viewer.runtime).toBe(runtime);
    expect(viewer.resolvedComposition).toBe("volume");
    expect(viewer.status).toBe("ready");
  });

  test("a container target intersects to all of a 3D dataset's compositions", async () => {
    const { container } = makeFakeContainer();
    const viewer = await makeViewer(container, { dataset: DESC_3D });
    expect(viewer.availableCompositions).toEqual(["slice", "volume", "quad", "grid"]);
  });

  test("a mesh through createViewer offers volume only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => OBJ,
    })));
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: { type: "mesh", source: "mem://mesh.obj" },
    });
    expect(viewer.dataset).toBeInstanceOf(MeshDataset);
    expect(viewer.resolvedComposition).toBe("volume"); // auto → mesh resolves to volume
    expect(viewer.availableCompositions).toEqual(["volume"]);
    expect(viewer.runtime!.getViewConfig("main")?.type).toBe("volume");
    expect(layerOf(viewer, "volume-mesh").type).toBe("surface");

    // Slice/quad are not buildable for a mesh — rejected up front, and
    // the running scene survives the rejected transitions.
    const runtime = viewer.runtime;
    await expect(viewer.setComposition({ type: "slice" })).rejects.toThrow(
      /Composition "slice" is not supported by dataset kind "mesh" \(available: volume\)/,
    );
    await expect(viewer.setComposition({ type: "quad" })).rejects.toThrow(/not supported by dataset kind "mesh"/);
    expect(viewer.runtime).toBe(runtime);
    expect(viewer.resolvedComposition).toBe("volume");
    expect(viewer.status).toBe("ready");
  });
});

// ============================================================================
// SLICE NAVIGATION
// ============================================================================

describe("slice navigation (setSlicePoint)", () => {
  test("setSlicePoint moves every slice layer and the camera focus", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, composition: { type: "slice" } });
    // physical z=6 with spacing 2 → slice index 3 (shape z=4 → 0..3).
    viewer.setSlicePoint([2, 2, 6]);
    expect(layerOf(viewer, "slice-c0").options).toMatchObject({ sliceIndex: 3 });
    expect(layerOf(viewer, "slice-c1").options).toMatchObject({ sliceIndex: 3 });
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([2, 2, 6]);
  });

  test("quad mode syncs each plane along its own through axis", async () => {
    const { container } = makeFakeContainer();
    const viewer = await makeViewer(container, { dataset: DESC_3D, composition: { type: "quad" } });
    viewer.setSlicePoint([1, 2, 6]); // spacing [0.5, 0.5, 2]
    expect(layerOf(viewer, "quad-xy-c0").options).toMatchObject({ sliceIndex: 3 }); // through z
    expect(layerOf(viewer, "quad-xz-c0").options).toMatchObject({ sliceIndex: 4 }); // through y
    expect(layerOf(viewer, "quad-yz-c0").options).toMatchObject({ sliceIndex: 2 }); // through x
  });

  test("entering slice mode with a preserved focus shows the slice at the focus", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // auto → volume
    viewer.runtime!.setTarget([1, 2, 6]);
    await viewer.setComposition({ type: "slice" });
    expect(layerOf(viewer, "slice-c0").options).toMatchObject({ sliceIndex: 3 });
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([1, 2, 6]);
  });

  test("setSlicePoint is a no-op in volume mode", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D }); // auto → volume
    const before = viewer.runtime!.getState().exploration.camera.target;
    viewer.setSlicePoint([0, 0, 0]);
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual(before);
  });
});

// ============================================================================
// PER-COMPOSITION OVERRIDES
// ============================================================================

describe("compositions", () => {
  test("per-mode channels/tools/controls apply on mode entry only", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      composition: { type: "slice" },
      compositions: {
        volume: {
          channels: [{ index: 1, visible: true, contrast: [0.1, 0.5] }],
          tools: { crosshair: true },
          controls: { fly: true },
        },
      },
    });

    // Slice: base state, no overrides.
    expect(layerOf(viewer, "slice-c1").render).toMatchObject({ visible: false, contrastLimits: [0, 1] });
    expect(viewer.runtime!.getViewConfig("main")?.overlays).toEqual({});
    expect(viewer.runtime!.getViewConfig("main")?.controls).toEqual({ panzoom: {} });

    // Volume: overrides applied on entry.
    await viewer.setComposition({ type: "volume" });
    expect(layerOf(viewer, "volume-c1").render).toMatchObject({ visible: true, contrastLimits: [0.1, 0.5] });
    expect(layerOf(viewer, "volume-c0").render).toMatchObject({ visible: true, contrastLimits: [0, 1] });
    expect(viewer.runtime!.getViewConfig("main")?.overlays).toEqual({ crosshair: {} });
    expect(viewer.runtime!.getViewConfig("main")?.controls).toEqual({ fly: {} });

    // Back to slice: base state again (overrides are per-mode, not sticky).
    await viewer.setComposition({ type: "slice" });
    expect(layerOf(viewer, "slice-c1").render).toMatchObject({ visible: false, contrastLimits: [0, 1] });
    expect(viewer.runtime!.getViewConfig("main")?.overlays).toEqual({});
  });

  test("viewer.view(mode).configure is the imperative equivalent", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, composition: { type: "slice" } });
    viewer.composition("volume").configure({ channels: [{ index: 0, contrast: [0.3, 0.7] }] });

    await viewer.setComposition({ type: "volume" });
    expect(layerOf(viewer, "volume-c0").render?.contrastLimits).toEqual([0.3, 0.7]);

    // Configuring the ACTIVE mode re-enters it immediately.
    viewer.composition("volume").configure({ tools: { ruler: true } });
    await viewer.ready;
    expect(viewer.runtime!.getViewConfig("main")?.overlays).toEqual({ ruler: {} });
  });

  test('mode override camera: "fit" forces a re-fit, explicit target wins over focus', async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      composition: { type: "slice" },
      compositions: { volume: { camera: { target: [9, 9, 9] } } },
    });
    viewer.runtime!.setTarget([1, 1, 1]);
    await viewer.setComposition({ type: "volume" });
    expect(viewer.runtime!.getState().exploration.camera.target).toEqual([9, 9, 9]);
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
      composition: { type: "volume" },
      compositions: { volume: { transform: affine } },
    });

    // Headless: no render pass runs, so drive the same per-frame applyConfig
    // call `BaseView.render` makes to realize config → live model matrix.
    const liveMatrices = () => {
      const state = viewer.runtime!.getState();
      return viewer.runtime!.view("main").base.getLayers().map((layer) => {
        const desc = state.layers!.find((l) => l.id === layer.id)!;
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
    expect(compositionOverridesOf(viewer)?.volume?.transform).toEqual(affine);

    // Slice mode declares no transform: layers get the physical-space default
    // (plane-local scale for the x/y plane → diag(4, 4, 1, 1)).
    await viewer.setComposition({ type: "slice" });
    expect(layerOf(viewer, "slice-c0").data?.transform).toBeUndefined();
    for (const m of liveMatrices()) {
      expect(m).toEqual([4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }

    // Back to volume: the rebuilt layers carry the affine again — the Viewer
    // owns re-application, no escape-hatch mutation needed.
    await viewer.setComposition({ type: "volume" });
    expect(layerOf(viewer, "volume-c0").data?.transform).toEqual(affine);
    for (const m of liveMatrices()) expect(m).toEqual(affine);
  });

  test("view(mode).configure({ transform }) is the imperative equivalent", async () => {
    const affine = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, composition: { type: "volume" } });
    // Configuring the ACTIVE mode re-enters it immediately with the transform.
    viewer.composition("volume").configure({ transform: affine });
    await viewer.ready;
    const state = viewer.runtime!.getState();
    for (const layer of viewer.runtime!.view("main").base.getLayers()) {
      const desc = state.layers!.find((l) => l.id === layer.id)!;
      layer.applyConfig(desc, state.physical);
      expect([...layer.modelMatrix]).toEqual(affine);
    }
    expect(compositionOverridesOf(viewer)?.volume?.transform).toEqual(affine);
  });

  test("mode override transform validation is actionable", async () => {
    const canvas = makeFakeCanvas();
    await expect(makeViewer(canvas, {
      dataset: DESC_3D,
      compositions: { volume: { transform: [1, 0, 0] } },
    })).rejects.toThrow(/compositions\.volume\.transform must be an array of 16 finite numbers/);
    await expect(makeViewer(canvas, {
      dataset: DESC_3D,
      compositions: { volume: { transform: new Array(16).fill(NaN) } },
    })).rejects.toThrow(/compositions\.volume\.transform must be an array of 16 finite numbers/);
  });
});

// ============================================================================
// QUAD MODE
// ============================================================================

describe("quad mode", () => {
  test("container target lays out three slice planes plus a volume view", async () => {
    const { container, el } = makeFakeContainer();
    const viewer = await makeViewer(container, { dataset: DESC_3D, composition: { type: "quad" } });
    expect(viewer.resolvedComposition).toBe("quad");

    const runtime = viewer.runtime!;
    for (const [id, axes] of [["quad-xy", ["x", "y"]], ["quad-xz", ["x", "z"]], ["quad-yz", ["y", "z"]]] as const) {
      const view = runtime.getViewConfig(id)!;
      expect(view.type).toBe("slice");
      expect(view.layers).toEqual([`${id}-c0`, `${id}-c1`]);
      expect(view.controls).toEqual({ panzoom: {} });
      expect(layerOf(viewer, `${id}-c0`).options?.axes).toEqual(axes);
      expect(layerOf(viewer, `${id}-c0`).options?.selection).toEqual({ c: 0 });
    }
    const volume = runtime.getViewConfig("quad-3d")!;
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
    await expect(makeViewer(makeFakeCanvas(), { dataset: DESC_3D, composition: { type: "quad" } })).rejects.toThrow(
      /quad.*requires a container element/,
    );
  });
});
