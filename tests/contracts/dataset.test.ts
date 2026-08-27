/**
 * Dataset tests — the dataset building block (datasetRegistry + openDataset)
 * and the resource contract: typed lookup semantics (primary / sole-matching
 * / ambiguity), the unique-ID and valid-primary invariants, resource-specific
 * metadata, and runtime ownership.
 *
 * openDataset constructs and loads a fresh Dataset per call (no caching);
 * disposal is the caller's job.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Dataset,
  openDataset,
  registerDatasetAdapter,
  type DatasetConfig,
  type DatasetResource,
  type ImagePyramidResource,
  type MeshResource,
} from "../../src/index";
import { datasetRegistry } from "../../src/registry";
import type { ImagePyramid } from "../../src/state/schema";

const KIND = "fake-dataset";

/**
 * Test kinds own an exact config in the map, like any format package (the
 * augmentation is compilation-wide; the runtime registration happens per
 * test below). The custom resource kind proves `DatasetResourceMap` is
 * augmentable the same way `DatasetConfigMap` is.
 */
declare module "galavi" {
  interface DatasetConfigMap {
    "fake-dataset": { type: "fake-dataset"; source: string };
  }
  interface DatasetResourceMap {
    "dataset-test-custom": { id: string; kind: "dataset-test-custom"; note: string };
  }
}

const PYRAMID_3D: ImagePyramid = {
  levels: [
    { path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [0.5, 0.5, 2] },
    { path: "1", shape: [4, 4, 2], chunkSize: [4, 4, 2], scale: [1, 1, 4] },
  ],
};

const CONFIG: DatasetConfig = { type: KIND, source: "mem://dataset" };

function imageResource(id: string, overrides: Partial<ImagePyramidResource> = {}): ImagePyramidResource {
  return {
    id,
    kind: "image-pyramid",
    pyramid: PYRAMID_3D,
    fetch: async () => new ArrayBuffer(0),
    physical: { spatial: { size: [4, 4, 8], spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } },
    dimensions: [{ name: "c", size: 2, labels: ["a", "b"] }],
    defaultSelection: { c: 0 },
    channels: [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: false },
    ],
    ...overrides,
  };
}

function meshResource(id: string): MeshResource {
  return { id, kind: "mesh", source: `mem://${id}.obj` };
}

class StubDataset extends Dataset {
  loaded = false;
  disposed = false;
  /** Test hook: what `load()` publishes (default: one primary image resource). */
  buildResources: () => { resources: DatasetResource[]; primary?: string } = () => ({
    resources: [imageResource("image")],
    primary: "image",
  });

  override async load(): Promise<void> {
    this.loaded = true;
    const { resources, primary } = this.buildResources();
    this.channels = [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: false },
    ];
    this.dimensions = [{ name: "c", size: 2, labels: ["a", "b"] }];
    this.defaultSelection = { c: 0 };
    this.resources = resources;
    if (primary !== undefined) this.primaryResourceId = primary;
  }

  override dispose(): void {
    this.disposed = true;
  }
}

/** Register the kind (optionally with a resource-set hook) and open it. */
async function openStub(
  buildResources?: StubDataset["buildResources"],
): Promise<StubDataset> {
  registerDatasetAdapter(KIND, (config) => {
    const dataset = new StubDataset(config);
    if (buildResources) dataset.buildResources = buildResources;
    return dataset;
  });
  return (await openDataset(CONFIG)) as StubDataset;
}

describe("openDataset", () => {
  afterEach(() => {
    datasetRegistry.unregister(KIND);
    vi.restoreAllMocks();
  });

  test("constructs through the registry, loads, and returns the instance", async () => {
    const factory = vi.fn((config: DatasetConfig) => new StubDataset(config));
    registerDatasetAdapter(KIND, factory);

    const dataset = await openDataset(CONFIG);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(CONFIG);
    expect(dataset).toBeInstanceOf(StubDataset);
    expect(dataset.type).toBe(KIND);
    expect((dataset as StubDataset).loaded).toBe(true);
    expect(dataset.channels).toHaveLength(2);
    // The stub publishes one primary image-pyramid resource.
    expect(dataset.resources).toHaveLength(1);
    expect(dataset.primaryResourceId).toBe("image");
    expect(dataset.resource("image-pyramid")).toBe(dataset.resources[0]);
  });

  test("every call constructs a fresh dataset (no caching; disposal is the caller's job)", async () => {
    const factory = vi.fn((config: DatasetConfig) => new StubDataset(config));
    registerDatasetAdapter(KIND, factory);

    const first = await openDataset(CONFIG);
    const second = await openDataset(CONFIG);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  test("rejects with an actionable error for an unknown kind", async () => {
    registerDatasetAdapter(KIND, (config) => new StubDataset(config));
    await expect(
      // @ts-expect-error — "nope" is not a registered loader key
      openDataset({ type: "nope", source: "mem://x" }),
    ).rejects.toThrow(
      /Unknown dataset kind: "nope" \(registered: [^)]*fake-dataset[^)]*\)\. Register a dataset kind first via registerDatasetAdapter\(\)\./,
    );
  });

  test('the "ome-zarr" kind error hints at the subpath import that provides it', async () => {
    registerDatasetAdapter(KIND, (config) => new StubDataset(config));
    // This file never imports ../src/dataset/adapters/ome-zarr, so the kind is
    // unregistered in this module graph (the config type compiles because the
    // augmentation is compilation-wide).
    await expect(openDataset({ type: "ome-zarr", source: "mem://x" })).rejects.toThrow(
      /Unknown dataset kind: "ome-zarr".*Did you mean to import "galavi\/ome-zarr"\?/,
    );
  });

  test("rejects for a config without a type", async () => {
    await expect(openDataset({} as DatasetConfig)).rejects.toThrow(
      /requires a config with a "type" string/,
    );
  });

  test("load failures reject as-is (plumbed through, not swallowed)", async () => {
    const cause = new Error("No OME-Zarr multiscales metadata found");
    class FailingDataset extends StubDataset {
      override async load(): Promise<void> {
        throw cause;
      }
    }
    registerDatasetAdapter(KIND, (config) => new FailingDataset(config));
    await expect(openDataset(CONFIG)).rejects.toBe(cause);
  });
});

describe("Dataset resource invariants", () => {
  afterEach(() => {
    datasetRegistry.unregister(KIND);
  });

  test("duplicate resource ids reject the open, naming the id", async () => {
    await expect(
      openStub(() => ({ resources: [imageResource("x"), imageResource("x")], primary: "x" })),
    ).rejects.toThrow(/duplicate resource id "x"/);
  });

  test("a primaryResourceId naming no resource rejects the open", async () => {
    await expect(
      openStub(() => ({ resources: [imageResource("x")], primary: "nope" })),
    ).rejects.toThrow(/primaryResourceId "nope" matches no resource/);
  });

  test("the invariants also fail at assignment time (not only at open)", () => {
    const dataset = new StubDataset(CONFIG);
    expect(() => {
      dataset.resources = [imageResource("x"), imageResource("x")];
    }).toThrow(/duplicate resource id "x"/);
    const other = new StubDataset(CONFIG);
    expect(() => {
      other.resources = [imageResource("x")];
      other.primaryResourceId = "nope";
    }).toThrow(/primaryResourceId "nope" matches no resource/);
  });
});

describe("Dataset.resource(kind, id?)", () => {
  afterEach(() => {
    datasetRegistry.unregister(KIND);
  });

  test("returns the primary resource when its kind matches (even with siblings of the kind)", async () => {
    const dataset = await openStub(() => ({
      resources: [imageResource("a"), imageResource("b")],
      primary: "b",
    }));
    expect(dataset.resource("image-pyramid")).toBe(dataset.resources[1]);
  });

  test("returns the sole matching resource when the primary is another kind", async () => {
    const dataset = await openStub(() => ({
      resources: [imageResource("image"), meshResource("mesh")],
      primary: "image",
    }));
    expect(dataset.resource("mesh")).toBe(dataset.resources[1]);
    expect(dataset.resource("image-pyramid")).toBe(dataset.resources[0]);
  });

  test("throws an actionable ambiguity error when several match and none is primary", async () => {
    const dataset = await openStub(() => ({
      resources: [imageResource("plane-xy"), imageResource("plane-xz"), meshResource("mesh")],
      primary: "mesh",
    }));
    expect(() => dataset.resource("image-pyramid")).toThrow(
      /ambiguous.*"plane-xy", "plane-xz".*dataset\.resource\("image-pyramid", id\)/,
    );
    // …and the explicit-id form the error points at resolves it.
    expect(dataset.resource("image-pyramid", "plane-xz")).toBe(dataset.resources[1]);
  });

  test("an explicit id looks the resource up and validates the kind", async () => {
    const dataset = await openStub(() => ({
      resources: [imageResource("image"), meshResource("mesh")],
      primary: "image",
    }));
    expect(dataset.resource("mesh", "mesh")).toBe(dataset.resources[1]);
    expect(dataset.resource("mesh", "nope")).toBeUndefined();
    expect(() => dataset.resource("mesh", "image")).toThrow(
      /resource "image".*is a "image-pyramid" resource/,
    );
  });

  test("returns undefined when nothing matches", async () => {
    const dataset = await openStub();
    expect(dataset.resource("mesh")).toBeUndefined();
    expect(dataset.resource("image-pyramid", "nope")).toBeUndefined();
  });

  test("custom resource kinds are typed through the augmented map", async () => {
    const dataset = await openStub(() => ({
      resources: [{ id: "custom", kind: "dataset-test-custom", note: "hello" }],
      primary: "custom",
    }));
    // Typed by the augmentation — no cast needed at the call site.
    const note: string | undefined = dataset.resource("dataset-test-custom")?.note;
    expect(note).toBe("hello");
  });

  test("resource-specific metadata stays attached to each resource", async () => {
    const xy = imageResource("plane-xy", {
      physical: { spatial: { size: [8, 4, 1], spacing: [0.5, 2, 2], origin: [0, 0, 0] } },
      defaultSelection: { c: 0, t: 3 },
    });
    const xz = imageResource("plane-xz", {
      physical: { spatial: { size: [8, 2, 4], spacing: [0.5, 1, 4], origin: [1, 0, 0] } },
      channels: [{ index: 0, label: "sum", color: "#FFFFFF", contrast: [0.1, 0.9], visible: true }],
    });
    const dataset = await openStub(() => ({ resources: [xy, xz], primary: "plane-xy" }));

    expect(dataset.resource("image-pyramid", "plane-xy")?.physical?.spatial.size).toEqual([8, 4, 1]);
    expect(dataset.resource("image-pyramid", "plane-xy")?.defaultSelection).toEqual({ c: 0, t: 3 });
    expect(dataset.resource("image-pyramid", "plane-xz")?.channels).toHaveLength(1);
    // Dataset-level metadata describes the primary/common domain and does not
    // leak into sibling resources.
    expect(dataset.resource("image-pyramid", "plane-xz")?.defaultSelection).toEqual({ c: 0 });
  });

  test("runtime functions are the exact objects the dataset loaded (ownership, no wrapping)", async () => {
    const fetch = async () => new ArrayBuffer(0);
    const dataset = await openStub(() => ({
      resources: [imageResource("image", { fetch })],
      primary: "image",
    }));
    expect(dataset.resource("image-pyramid")?.fetch).toBe(fetch);
    expect(dataset.resource("image-pyramid")?.pyramid).toBe(PYRAMID_3D);
  });

  test("disposal is the kind's job; the stub releases its flag exactly once", async () => {
    const dataset = await openStub();
    expect(dataset.disposed).toBe(false);
    dataset.dispose();
    expect(dataset.disposed).toBe(true);
  });
});
