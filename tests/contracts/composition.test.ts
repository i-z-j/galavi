/**
 * Reference-composition tests (src/viewer/compositions/*) — the pure builders
 * the Viewer resolves compositions against: `supports(dataset)` from the
 * primary normalized resource, `build(...)` translating resources into a
 * CompositionPlan (generated layers + canvas-free views + layout + bindings),
 * and the `"auto"` resolution policy.
 */
import { describe, expect, test } from "vitest";
import {
  Dataset,
  type DatasetConfig,
  type DatasetResource,
  type ImagePyramidResource,
  type MeshResource,
} from "../../src/index";
import {
  gridComposition,
  quadComposition,
  resolveAutoComposition,
  resolveComposition,
  sliceComposition,
  supportedCompositions,
  volumeComposition,
} from "../../src/viewer/compositions";
import { parseOBJ } from "../../src/dataset/adapters/mesh";
import type { ImagePyramid } from "../../src/state/schema";

declare module "galavi" {
  interface DatasetConfigMap {
    "composition-stub": { type: "composition-stub"; source: string };
  }
  interface DatasetResourceMap {
    "composition-custom": { id: string; kind: "composition-custom" };
  }
}

const CONFIG: DatasetConfig = { type: "composition-stub", source: "mem://x" };

const PYRAMID_3D: ImagePyramid = {
  levels: [
    { path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [0.5, 0.5, 2] },
    { path: "1", shape: [4, 4, 2], chunkSize: [4, 4, 2], scale: [1, 1, 4] },
  ],
};
const PYRAMID_2D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 1], chunkSize: [4, 4, 1], scale: [1, 1, 1] }],
};
/** z-chunk=1 with more slabs than the preview budget. */
const PYRAMID_STRIDED: ImagePyramid = {
  levels: [{ path: "0", shape: [256, 256, 500], chunkSize: [256, 256, 1], scale: [1, 1, 1] }],
};
const PYRAMID_EMPTY: ImagePyramid = { levels: [] };

const OBJ = ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n");

class StubDataset extends Dataset {
  override async load(): Promise<void> {}
  override dispose(): void {}
}

function imageResource(id: string, pyramid: ImagePyramid): ImagePyramidResource {
  return {
    id,
    kind: "image-pyramid",
    pyramid,
    fetch: async () => new ArrayBuffer(0),
    physical: { spatial: { size: [4, 4, 8], spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } },
    dimensions: [{ name: "c", size: 2, labels: ["a", "b"] }],
    defaultSelection: { c: 0 },
    channels: [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: false },
    ],
  };
}

function datasetWith(resources: DatasetResource[], primary?: string): StubDataset {
  const dataset = new StubDataset(CONFIG);
  dataset.resources = resources;
  if (primary !== undefined) dataset.primaryResourceId = primary;
  return dataset;
}

function imageDataset(pyramid: ImagePyramid): StubDataset {
  return datasetWith([imageResource("image", pyramid)], "image");
}

function meshDataset(overrides: Partial<MeshResource> = {}): StubDataset {
  return datasetWith(
    [{ id: "mesh", kind: "mesh", source: "mem://mesh.obj", ...overrides }],
    "mesh",
  );
}

// ============================================================================
// SUPPORTS / RESOLUTION
// ============================================================================

describe("composition supports(dataset)", () => {
  test("2D image: slice + grid (no volume layouts)", () => {
    const dataset = imageDataset(PYRAMID_2D);
    expect(sliceComposition.supports(dataset)).toBe(true);
    expect(volumeComposition.supports(dataset)).toBe(false);
    expect(quadComposition.supports(dataset)).toBe(false);
    expect(gridComposition.supports(dataset)).toBe(true);
    expect(supportedCompositions(dataset)).toEqual(["slice", "grid"]);
  });

  test("3D image: all four reference compositions, in resolution order", () => {
    const dataset = imageDataset(PYRAMID_3D);
    expect(sliceComposition.supports(dataset)).toBe(true);
    expect(volumeComposition.supports(dataset)).toBe(true);
    expect(quadComposition.supports(dataset)).toBe(true);
    expect(supportedCompositions(dataset)).toEqual(["slice", "volume", "quad", "grid"]);
  });

  test("z-chunk=1 pathological pyramid: bounded preview keeps volume + quad", () => {
    expect(supportedCompositions(imageDataset(PYRAMID_STRIDED))).toEqual(["slice", "volume", "quad", "grid"]);
  });

  test("empty pyramid: slice only (the grid needs at least one level)", () => {
    expect(supportedCompositions(imageDataset(PYRAMID_EMPTY))).toEqual(["slice"]);
  });

  test("mesh-only: volume only", () => {
    const dataset = meshDataset();
    expect(sliceComposition.supports(dataset)).toBe(false);
    expect(volumeComposition.supports(dataset)).toBe(true);
    expect(quadComposition.supports(dataset)).toBe(false);
    expect(gridComposition.supports(dataset)).toBe(false);
    expect(supportedCompositions(dataset)).toEqual(["volume"]);
  });

  test("an unsupported custom resource: nothing supports it", () => {
    const dataset = datasetWith([{ id: "weird", kind: "composition-custom" }], "weird");
    expect(supportedCompositions(dataset)).toEqual([]);
  });

  test("support derives from the PRIMARY resource — siblings are not consulted", () => {
    // A custom primary with a perfectly good image sibling: the reference
    // compositions translate the primary, so nothing supports this dataset.
    const dataset = datasetWith(
      [{ id: "weird", kind: "composition-custom" }, imageResource("image", PYRAMID_3D)],
      "weird",
    );
    expect(supportedCompositions(dataset)).toEqual([]);
  });

  test("a sole resource stands in for an undeclared primary", () => {
    const dataset = datasetWith([imageResource("image", PYRAMID_3D)]);
    expect(supportedCompositions(dataset)).toEqual(["slice", "volume", "quad", "grid"]);
  });

  test("several resources without a primary: no normalized primary, no support", () => {
    const dataset = datasetWith([
      imageResource("a", PYRAMID_3D),
      imageResource("b", PYRAMID_3D),
    ]);
    expect(supportedCompositions(dataset)).toEqual([]);
  });
});

describe("resolveAutoComposition (the \"auto\" policy)", () => {
  test("3D image → volume", () => {
    expect(resolveAutoComposition(imageDataset(PYRAMID_3D))).toBe("volume");
  });

  test("2D image → slice", () => {
    expect(resolveAutoComposition(imageDataset(PYRAMID_2D))).toBe("slice");
  });

  test("mesh-only → volume", () => {
    expect(resolveAutoComposition(meshDataset())).toBe("volume");
  });

  test("an unsupported dataset → undefined (the Viewer errors actionably)", () => {
    const dataset = datasetWith([{ id: "weird", kind: "composition-custom" }], "weird");
    expect(resolveAutoComposition(dataset)).toBeUndefined();
  });
});

describe("resolveComposition (the registry path)", () => {
  test("returns the registered composition for each built-in type", () => {
    expect(resolveComposition("slice")).toBe(sliceComposition);
    expect(resolveComposition("volume")).toBe(volumeComposition);
    expect(resolveComposition("quad")).toBe(quadComposition);
    expect(resolveComposition("grid")).toBe(gridComposition);
  });

  test("an unknown type rejects with a CapabilityResolutionError", () => {
    expect(() => resolveComposition("nope")).toThrow(/Unknown composition type: "nope"/);
  });
});

// ============================================================================
// BUILD — resource → plan translation
// ============================================================================

describe("volumeComposition.build", () => {
  test("translates the image resource into one additive layer per channel", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const resource = dataset.resource("image-pyramid")!;
    const plan = volumeComposition.build({
      dataset, channels: resource.channels, projection: "mip",
    });

    expect(plan.layers.map((layer) => layer.id)).toEqual(["volume-c0", "volume-c1"]);
    expect(plan.views.main.layers).toEqual(["volume-c0", "volume-c1"]);
    expect(plan.views.main.type).toBe("volume");
    expect(plan.activeViewId).toBe("main");
    expect(plan.layout).toEqual({ kind: "single" });
    expect(plan.bindings.projectionLayers).toEqual(["volume-c0", "volume-c1"]);
    expect(plan.bindings.channels).toEqual(new Map([
      [0, ["volume-c0"]],
      [1, ["volume-c1"]],
    ]));
    expect(plan.bindings.slicePlanes).toEqual([]);
    for (const [index, layer] of plan.layers.entries()) {
      expect(layer.type).toBe("volume");
      expect(layer.data?.pyramid).toBe(resource.pyramid);
      expect(layer.data?.fetch).toBe(resource.fetch);
      expect(layer.data).not.toHaveProperty("transform");
      expect(layer.options?.selection).toEqual({ c: index });
      expect(layer.options).not.toHaveProperty("axes");
      expect(layer.render?.blending).toBe("additive");
      expect(layer.render?.volumeProjection).toBe("mip");
    }
    expect(plan.layers[0].render).toMatchObject({ visible: true, color: "#00B0FF", contrastLimits: [0, 1] });
    expect(plan.layers[1].render).toMatchObject({ visible: false, color: "#FF3D3D" });
  });

  test("the composition transform is copied into each image layer's data", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const resource = dataset.resource("image-pyramid")!;
    const transform = [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1];
    const plan = volumeComposition.build({
      dataset, channels: resource.channels, projection: "mip", transform,
    });
    for (const layer of plan.layers) {
      expect(layer.data?.transform).toEqual(transform);
      expect(layer.data?.transform).not.toBe(transform);
    }
  });

  test("mesh primary: the surface layer adopts a defensive copy of the loaded geometry", () => {
    const dataset = meshDataset({ geometry: parseOBJ(OBJ) });
    const resource = dataset.resource("mesh")!;
    const plan = volumeComposition.build({ dataset, channels: [] });

    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0].id).toBe("volume-mesh");
    expect(plan.layers[0].type).toBe("surface");
    expect(plan.layers[0].data?.url).toBe("mem://mesh.obj");
    expect(plan.layers[0].options).toEqual({ fitToUnitAABB: true });
    // A mesh has no channel/projection/slice bindings.
    expect(plan.bindings.channels.size).toBe(0);
    expect(plan.bindings.projectionLayers).toEqual([]);

    // The hand-off carries the parsed geometry (1 triangle → 3 vertices) as a
    // defensive copy: mutating the layer's positions must not corrupt the
    // geometry retained on the resource for the next scene rebuild.
    const handed = plan.layers[0].data?.geometry;
    expect(handed?.positions).toBeInstanceOf(Float32Array);
    expect(handed?.vertexCount).toBe(3);
    expect(handed?.positions).not.toBe(resource.geometry?.positions);
    handed!.positions[0] = 999;
    expect(resource.geometry!.positions[0]).not.toBe(999);
  });

  test("a URL-backed mesh resource (no loaded geometry) builds a fetching surface layer", () => {
    const dataset = meshDataset();
    const plan = volumeComposition.build({ dataset, channels: [] });
    expect(plan.layers[0].data?.url).toBe("mem://mesh.obj");
    expect(plan.layers[0].data?.geometry).toBeUndefined();
  });

  test("build throws an actionable error for an unsupported primary", () => {
    const dataset = datasetWith([{ id: "weird", kind: "composition-custom" }], "weird");
    expect(() => volumeComposition.build({ dataset, channels: [] })).toThrow(
      /composition "volume" cannot build a scene for dataset kind "composition-stub".*supports\(\)/,
    );
  });
});

describe("sliceComposition.build", () => {
  test("one slice layer per channel; no projection, no plane axes", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const resource = dataset.resource("image-pyramid")!;
    const plan = sliceComposition.build({ dataset, channels: resource.channels });

    expect(plan.layers.map((layer) => layer.id)).toEqual(["slice-c0", "slice-c1"]);
    expect(plan.views.main.layers).toEqual(["slice-c0", "slice-c1"]);
    expect(plan.views.main.type).toBe("slice");
    expect(plan.layout).toEqual({ kind: "single" });
    expect(plan.layers[0].type).toBe("slice");
    expect(plan.layers[0].render?.volumeProjection).toBeUndefined();
    expect(plan.layers[0].options).not.toHaveProperty("axes");
    expect(plan.layers[1].options?.selection).toEqual({ c: 1 });

    // The slice-plane binding drives the facade's focus sync: the x/y plane
    // slices through z (the resolved axis map's third entry).
    expect(plan.bindings.slicePlanes).toEqual([
      { viewId: "main", layerIds: ["slice-c0", "slice-c1"], axes: [0, 1, 2] },
    ]);
    expect(plan.bindings.projectionLayers).toEqual([]);

    expect(() => sliceComposition.build({ dataset: meshDataset(), channels: [] })).toThrow(
      /composition "slice" cannot build a scene/,
    );
  });
});

describe("quadComposition.build", () => {
  test("three axis-pinned slice planes plus a volume view, one layer per channel each", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const resource = dataset.resource("image-pyramid")!;
    const plan = quadComposition.build({
      dataset, channels: resource.channels, projection: "mip",
    });

    expect(plan.layout).toEqual({ kind: "quad" });
    expect(plan.activeViewId).toBe("quad-xy");
    expect(Object.keys(plan.views)).toEqual(["quad-xy", "quad-xz", "quad-yz", "quad-3d"]);
    const expected: [string, readonly string[]][] = [
      ["quad-xy", ["x", "y"]],
      ["quad-xz", ["x", "z"]],
      ["quad-yz", ["y", "z"]],
    ];
    for (const [id, axes] of expected) {
      expect(plan.views[id].layers).toEqual([`${id}-c0`, `${id}-c1`]);
      expect(plan.views[id].type).toBe("slice");
      const first = plan.layers.find((layer) => layer.id === `${id}-c0`)!;
      expect(first.type).toBe("slice");
      expect(first.options?.axes).toEqual(axes);
      expect(first.options?.selection).toEqual({ c: 0 });
      expect(first.render?.volumeProjection).toBeUndefined();
    }
    expect(plan.views["quad-3d"].layers).toEqual(["quad-3d-c0", "quad-3d-c1"]);
    expect(plan.views["quad-3d"].type).toBe("volume");
    const volume = plan.layers.find((layer) => layer.id === "quad-3d-c1")!;
    expect(volume.type).toBe("volume");
    expect(volume.render?.volumeProjection).toBe("mip");

    // Bindings: every channel binds its four layers; only the 3D view's
    // layers project; each plane syncs along its own through axis.
    expect(plan.bindings.channels).toEqual(new Map([
      [0, ["quad-xy-c0", "quad-xz-c0", "quad-yz-c0", "quad-3d-c0"]],
      [1, ["quad-xy-c1", "quad-xz-c1", "quad-yz-c1", "quad-3d-c1"]],
    ]));
    expect(plan.bindings.projectionLayers).toEqual(["quad-3d-c0", "quad-3d-c1"]);
    expect(plan.bindings.slicePlanes.map((plane) => [plane.viewId, plane.axes])).toEqual([
      ["quad-xy", [0, 1, 2]],
      ["quad-xz", [0, 2, 1]],
      ["quad-yz", [1, 2, 0]],
    ]);

    // Layer construction order: planes first, then the volume view.
    expect(plan.layers.map((layer) => layer.id)).toEqual([
      "quad-xy-c0", "quad-xy-c1",
      "quad-xz-c0", "quad-xz-c1",
      "quad-yz-c0", "quad-yz-c1",
      "quad-3d-c0", "quad-3d-c1",
    ]);
  });
});

describe("gridComposition.build", () => {
  const resource = () => imageResource("image", PYRAMID_3D); // z = 4 at the finest level

  test("one slice view per pool cell, one layer per cell per channel", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const plan = gridComposition.build({
      dataset, channels: resource().channels, config: { pool: 2 },
    });

    expect(plan.layout).toEqual({ kind: "grid", pool: 2 });
    expect(plan.config).toEqual({ pool: 2, page: 0 });
    expect(Object.keys(plan.views)).toEqual(["grid-cell-0", "grid-cell-1"]);
    expect(plan.views["grid-cell-0"]).toMatchObject({
      type: "slice", layers: ["grid-cell-0-c0", "grid-cell-0-c1"], activatable: false,
    });
    expect(plan.layers.map((layer) => layer.id)).toEqual([
      "grid-cell-0-c0", "grid-cell-0-c1",
      "grid-cell-1-c0", "grid-cell-1-c1",
    ]);
    // Page 0 with z=4: cells 0 and 1 show slices 0 and 1, both visible per
    // each channel's own visibility.
    expect(plan.layers[0].options).toMatchObject({ sliceIndex: 0, axes: ["x", "y"] });
    expect(plan.layers[0].render?.visible).toBe(true);
    expect(plan.layers[1].render?.visible).toBe(false); // channel 1 hidden
    expect(plan.layers[2].options).toMatchObject({ sliceIndex: 1 });
    // Bindings: per-channel layer ids across cells; no projection, no
    // focus-driven slice planes (paging is config-driven).
    expect(plan.bindings.channels).toEqual(new Map([
      [0, ["grid-cell-0-c0", "grid-cell-1-c0"]],
      [1, ["grid-cell-0-c1", "grid-cell-1-c1"]],
    ]));
    expect(plan.bindings.projectionLayers).toEqual([]);
    expect(plan.bindings.slicePlanes).toEqual([]);
  });

  test("page turns derive per-cell slices; the out-of-range tail hides", () => {
    const dataset = imageDataset(PYRAMID_3D); // z = 4
    const plan = gridComposition.build({
      dataset, channels: resource().channels, config: { pool: 3, page: 1 },
    });
    expect(plan.config).toEqual({ pool: 3, page: 1 });
    // Cells: 3, 4, 5 — only slice 3 exists, so cells 1+ hide (both channels).
    expect(plan.layers.map((layer) => [
      layer.id,
      layer.options?.sliceIndex,
      layer.render?.visible,
    ])).toEqual([
      ["grid-cell-0-c0", 3, true],
      ["grid-cell-0-c1", 3, false],
      ["grid-cell-1-c0", 0, false], // hidden cell: sliceIndex defaults to 0
      ["grid-cell-1-c1", 0, false],
      ["grid-cell-2-c0", 0, false],
      ["grid-cell-2-c1", 0, false],
    ]);
  });

  test("explicit slices take precedence over the page (null hides a cell)", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const plan = gridComposition.build({
      dataset, channels: resource().channels, config: { slices: [2, null], page: 7 },
    });
    // slices.length IS the pool size when pool is not given.
    expect(plan.layout).toEqual({ kind: "grid", pool: 2 });
    expect(plan.config).toEqual({ pool: 2, page: 7, slices: [2, null] });
    expect(plan.layers[0].options?.sliceIndex).toBe(2);
    expect(plan.layers[0].render?.visible).toBe(true);
    expect(plan.layers[2].render?.visible).toBe(false); // the null cell
  });

  test("config validation is actionable", () => {
    const dataset = imageDataset(PYRAMID_3D);
    const channels = resource().channels;
    expect(() => gridComposition.build({ dataset, channels, config: { pool: 0 } }))
      .toThrow(/pool must be a positive integer/);
    expect(() => gridComposition.build({ dataset, channels, config: { page: -1 } }))
      .toThrow(/page must be a non-negative integer/);
    expect(() => gridComposition.build({ dataset, channels, config: { pool: 2, slices: [1] } }))
      .toThrow(/slices has 1 entries but the pool size is 2/);
    expect(() => gridComposition.build({ dataset, channels, config: { slices: [1.5] } }))
      .toThrow(/slices\[0\] must be a non-negative integer or null/);
  });

  test("a source without a c axis writes no selection.c", () => {
    const noC: ImagePyramidResource = {
      ...imageResource("image", PYRAMID_3D),
      dimensions: [],
      defaultSelection: {},
    };
    const dataset = datasetWith([noC], "image");
    const plan = gridComposition.build({ dataset, channels: noC.channels, config: { pool: 1 } });
    expect(plan.layers[0].options?.selection).toEqual({});
  });

  test("build rejects an empty pyramid and an unsupported primary", () => {
    expect(() => gridComposition.build({
      dataset: imageDataset(PYRAMID_EMPTY), channels: [],
    })).toThrow(/empty pyramid/);
    expect(() => gridComposition.build({ dataset: meshDataset(), channels: [] })).toThrow(
      /composition "grid" cannot build a scene/,
    );
  });
});
