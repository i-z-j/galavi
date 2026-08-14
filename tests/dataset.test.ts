/**
 * Dataset resolution tests (DX-M1).
 *
 * Covers the resolver registry dispatch, unknown-type errors, per-source-identity
 * caching (resolve once, share across opens), invalidation, rejection eviction,
 * and capability derivation (2D vs 3D, z-chunk=1 bounded preview).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  datasetCacheKey,
  getDatasetCapabilities,
  invalidateAllDatasets,
  invalidateDataset,
  openDataset,
  registerDatasetResolver,
  type ResolvedDataset,
} from "../src/index";
import { datasetResolverRegistry } from "../src/dataset";
import type { ImagePyramid, SourceDescriptor } from "../src/types";

const TYPE = "fake-dataset";

const PYRAMID_3D: ImagePyramid = {
  levels: [
    { path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [0.5, 0.5, 2] },
    { path: "1", shape: [4, 4, 2], chunkSize: [4, 4, 2], scale: [1, 1, 4] },
  ],
};

const PYRAMID_2D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 1], chunkSize: [4, 4, 1], scale: [1, 1, 1] }],
};

/** z-chunk=1 with more slabs than the preview budget — the DX-M4 pathology. */
const PYRAMID_STRIDED: ImagePyramid = {
  levels: [{ path: "0", shape: [256, 256, 500], chunkSize: [256, 256, 1], scale: [1, 1, 1] }],
};

const DESC: SourceDescriptor = { type: TYPE, url: "mem://dataset" };

function fakeDataset(source: SourceDescriptor): ResolvedDataset {
  return {
    source,
    pyramid: PYRAMID_3D,
    fetch: async () => new ArrayBuffer(0),
    physical: { spatial: { size: [4, 4, 8], unit: "μm", spacing: [0.5, 0.5, 2], origin: [0, 0, 0] } },
    dimensions: [{ name: "c", size: 2, labels: ["a", "b"] }],
    defaultSelection: { c: 0 },
    channels: [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: false },
    ],
    dtype: "uint8",
    capabilities: getDatasetCapabilities(PYRAMID_3D),
  };
}

describe("openDataset", () => {
  afterEach(() => {
    datasetResolverRegistry.unregister(TYPE);
    invalidateAllDatasets();
    vi.restoreAllMocks();
  });

  test("dispatches through the resolver registry and returns the dataset", async () => {
    const resolver = vi.fn(async (desc: SourceDescriptor) => fakeDataset(desc));
    registerDatasetResolver(TYPE, resolver);

    const dataset = await openDataset(DESC);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(DESC);
    expect(dataset.channels).toHaveLength(2);
    expect(dataset.capabilities.supports3D).toBe(true);
  });

  test("rejects with an actionable error for an unknown source type", async () => {
    registerDatasetResolver(TYPE, async (desc) => fakeDataset(desc));
    await expect(openDataset({ type: "nope", url: "mem://x" })).rejects.toThrow(
      /Unknown dataset source type: "nope" \(registered: fake-dataset\).*registerOMEZarrSource/,
    );
  });

  test("rejects for a descriptor without a type", async () => {
    await expect(openDataset({} as SourceDescriptor)).rejects.toThrow(
      /requires a source descriptor with a "type" string/,
    );
  });

  test("caches per source identity: sequential and concurrent opens resolve once", async () => {
    const resolver = vi.fn(async (desc: SourceDescriptor) => fakeDataset(desc));
    registerDatasetResolver(TYPE, resolver);

    const first = await openDataset(DESC);
    const second = await openDataset({ type: TYPE, url: "mem://dataset" }); // equal identity, new object
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    // Concurrent opens share the in-flight promise.
    invalidateAllDatasets();
    const [a, b] = await Promise.all([openDataset(DESC), openDataset(DESC)]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);

    // A different url is a different identity.
    await openDataset({ type: TYPE, url: "mem://other" });
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  test("identity falls back to stable descriptor serialization when url is absent", () => {
    const a = datasetCacheKey({ type: TYPE, bucket: "b", prefix: "p" });
    const b = datasetCacheKey({ type: TYPE, prefix: "p", bucket: "b" }); // key order differs
    expect(a).toBe(b);
    expect(a).not.toBe(datasetCacheKey({ type: TYPE, bucket: "b" }));
  });

  test("invalidateDataset drops the cached entry; the next open re-resolves", async () => {
    const resolver = vi.fn(async (desc: SourceDescriptor) => fakeDataset(desc));
    registerDatasetResolver(TYPE, resolver);

    const first = await openDataset(DESC);
    expect(invalidateDataset(DESC)).toBe(true);
    expect(invalidateDataset(DESC)).toBe(false); // already gone
    const second = await openDataset(DESC);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  test("rejections are evicted — a fixed resolver can be retried", async () => {
    let fail = true;
    const resolver = vi.fn(async (desc: SourceDescriptor) => {
      if (fail) throw new Error("network down");
      return fakeDataset(desc);
    });
    registerDatasetResolver(TYPE, resolver);

    await expect(openDataset(DESC)).rejects.toThrow("network down");
    fail = false;
    await expect(openDataset(DESC)).resolves.toMatchObject({ dtype: "uint8" });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test("resolver errors reject as-is (plumbed through, not swallowed)", async () => {
    const cause = new Error("No OME-Zarr multiscales metadata found");
    registerDatasetResolver(TYPE, () => Promise.reject(cause));
    await expect(openDataset(DESC)).rejects.toBe(cause);
  });

  test("invalidateAllDatasets clears every cached entry", async () => {
    const resolver = vi.fn(async (desc: SourceDescriptor) => fakeDataset(desc));
    registerDatasetResolver(TYPE, resolver);

    await openDataset(DESC);
    await openDataset({ type: TYPE, url: "mem://other" });
    invalidateAllDatasets();
    await openDataset(DESC);
    await openDataset({ type: TYPE, url: "mem://other" });
    expect(resolver).toHaveBeenCalledTimes(4);
  });
});

describe("getDatasetCapabilities", () => {
  test("2D pyramid: no 3D, no volume preview", () => {
    expect(getDatasetCapabilities(PYRAMID_2D)).toEqual({
      zDepth: 1,
      supports3D: false,
      supportsVolumePreview: false,
    });
  });

  test("well-behaved 3D pyramid: volume preview without the budget policy", () => {
    expect(getDatasetCapabilities(PYRAMID_3D)).toEqual({
      zDepth: 4,
      supports3D: true,
      supportsVolumePreview: true,
    });
  });

  test("z-chunk=1 pathological pyramid: bounded volume preview via the policy", () => {
    const caps = getDatasetCapabilities(PYRAMID_STRIDED);
    expect(caps).toEqual({ zDepth: 500, supports3D: true, supportsVolumePreview: true });
  });

  test("empty pyramid: no capabilities", () => {
    expect(getDatasetCapabilities({ levels: [] })).toEqual({
      zDepth: 0,
      supports3D: false,
      supportsVolumePreview: false,
    });
  });
});
