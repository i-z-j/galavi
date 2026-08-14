/**
 * Dataset tests — the dataset building block (datasetRegistry + openDataset)
 * and capability derivation (2D vs 3D, z-chunk=1 bounded preview).
 *
 * openDataset constructs and loads a fresh Dataset per call (no caching);
 * disposal is the caller's job.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Dataset,
  getDatasetCapabilities,
  openDataset,
  registerDataset,
  type DatasetConfig,
  type DatasetDefaults,
} from "../src/index";
import { datasetRegistry } from "../src/registry";
import type { ImagePyramid, LayerConfig } from "../src/types";

const KIND = "fake-dataset";

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

const CONFIG: DatasetConfig = { type: KIND, source: "mem://dataset" };

class StubDataset extends Dataset {
  loaded = false;
  disposed = false;

  override async load(): Promise<void> {
    this.loaded = true;
    this.channels = [
      { index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "b", color: "#FF3D3D", contrast: [0, 1], visible: false },
    ];
    this.dimensions = [{ name: "c", size: 2, labels: ["a", "b"] }];
    this.defaultSelection = { c: 0 };
    this.capabilities = getDatasetCapabilities(PYRAMID_3D);
  }

  override dispose(): void {
    this.disposed = true;
  }

  override deriveDefaults(): DatasetDefaults {
    return { mode: "volume", selection: { ...this.defaultSelection } };
  }

  override createDefaultLayers(): LayerConfig[] {
    return [];
  }
}

describe("openDataset", () => {
  afterEach(() => {
    datasetRegistry.unregister(KIND);
    vi.restoreAllMocks();
  });

  test("constructs through the registry, loads, and returns the instance", async () => {
    const factory = vi.fn((config: DatasetConfig) => new StubDataset(config));
    registerDataset(KIND, factory);

    const dataset = await openDataset(CONFIG);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(CONFIG);
    expect(dataset).toBeInstanceOf(StubDataset);
    expect(dataset.type).toBe(KIND);
    expect((dataset as StubDataset).loaded).toBe(true);
    expect(dataset.channels).toHaveLength(2);
    expect(dataset.capabilities.supports3D).toBe(true);
  });

  test("every call constructs a fresh dataset (no caching; disposal is the caller's job)", async () => {
    const factory = vi.fn((config: DatasetConfig) => new StubDataset(config));
    registerDataset(KIND, factory);

    const first = await openDataset(CONFIG);
    const second = await openDataset(CONFIG);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  test("rejects with an actionable error for an unknown kind", async () => {
    registerDataset(KIND, (config) => new StubDataset(config));
    await expect(openDataset({ type: "nope", source: "mem://x" })).rejects.toThrow(
      /Unknown dataset kind: "nope" \(registered: fake-dataset\)\. Register a dataset kind first via registerDataset\(\)\./,
    );
  });

  test('the "image" kind error hints at the out-of-core adapter import', async () => {
    registerDataset(KIND, (config) => new StubDataset(config));
    await expect(openDataset({ type: "image", source: "mem://x" })).rejects.toThrow(
      /Unknown dataset kind: "image".*Did you mean to import "galavi\/ome-zarr"\?/,
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
    registerDataset(KIND, (config) => new FailingDataset(config));
    await expect(openDataset(CONFIG)).rejects.toBe(cause);
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
