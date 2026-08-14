/**
 * ImageDataset ("image" kind) tests.
 *
 * `src/dataset/ome-zarr.ts` self-registers the "image" dataset kind on module
 * load, so `openDataset({ type: "image", source })` resolves a normalized
 * ImageDataset: channels (colors/labels/contrast/active), physical space,
 * default selection, and 2D/3D + bounded-preview capabilities. Runs against
 * deterministic in-memory stores served through a stubbed global fetch
 * (no network). Also covers `deriveDefaults` and the per-channel
 * `createDefaultLayers` translation the Viewer facade drives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDataset } from "../src/index";
import { ImageDataset } from "../src/dataset/ome-zarr";

const MULTI_URL = "https://example.test/multichannel.ome.zarr";
const PLANE_URL = "https://example.test/plane.ome.zarr";
const EMPTY_URL = "https://example.test/empty.ome.zarr";
const NOOMERO_URL = "https://example.test/no-omero.ome.zarr";
const STRIDED_URL = "https://example.test/strided.ome.zarr";

// 3D multichannel store: shape [c=2, z=4, y=8, x=8], chunks [1, 2, 4, 4],
// uint8, omero channel metadata (labels/colors/window/active).
const MULTI_GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
      name: "test-multichannel",
      multiscales: [{
        name: "test",
        axes: [
          { name: "c", type: "channel" },
          { name: "z", type: "space", unit: "micrometer" },
          { name: "y", type: "space", unit: "micrometer" },
          { name: "x", type: "space", unit: "micrometer" },
        ],
        datasets: [{
          path: "0",
          coordinateTransformations: [{ type: "scale", scale: [1, 2, 0.5, 0.5] }],
        }],
      }],
      omero: {
        channels: [
          {
            label: "DAPI",
            color: "0000FF",
            active: true,
            window: { min: 0, max: 255, start: 51, end: 153 },
          },
          { label: "GFP", color: "00FF00", active: false },
        ],
      },
    },
  },
});

const MULTI_ARRAY_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [2, 4, 8, 8],
  data_type: "uint8",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 2, 4, 4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: 0,
  codecs: [{ name: "bytes", configuration: {} }],
  attributes: {},
  dimension_names: ["c", "z", "y", "x"],
});

// 2D store: no z axis, no omero metadata. shape [y=8, x=8], chunks [4, 4].
const PLANE_GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
      multiscales: [{
        axes: [
          { name: "y", type: "space" },
          { name: "x", type: "space" },
        ],
        datasets: [{
          path: "0",
          coordinateTransformations: [{ type: "scale", scale: [0.5, 0.5] }],
        }],
      }],
    },
  },
});

const PLANE_ARRAY_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [8, 8],
  data_type: "uint16",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: 0,
  codecs: [{ name: "bytes", configuration: {} }],
  attributes: {},
  dimension_names: ["y", "x"],
});

// A group with no multiscales metadata at all.
const EMPTY_GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {},
});

// 2D multichannel store without omero metadata: shape [c=3, y=8, x=8].
const NOOMERO_GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
      multiscales: [{
        axes: [
          { name: "c", type: "channel" },
          { name: "y", type: "space" },
          { name: "x", type: "space" },
        ],
        datasets: [{
          path: "0",
          coordinateTransformations: [{ type: "scale", scale: [1, 0.5, 0.5] }],
        }],
      }],
    },
  },
});

const NOOMERO_ARRAY_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [3, 8, 8],
  data_type: "uint8",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 4, 4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: 0,
  codecs: [{ name: "bytes", configuration: {} }],
  attributes: {},
  dimension_names: ["c", "y", "x"],
});

// z-chunk=1 store (the DX-M4 pathology): two levels, metadata only.
const STRIDED_GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
      multiscales: [{
        axes: [
          { name: "z", type: "space" },
          { name: "y", type: "space" },
          { name: "x", type: "space" },
        ],
        datasets: [
          { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }] },
          { path: "1", coordinateTransformations: [{ type: "scale", scale: [2, 2, 2] }] },
        ],
      }],
    },
  },
});

function arrayJson(shape: number[], chunkShape: number[]) {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "uint8",
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunkShape } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0,
    codecs: [{ name: "bytes", configuration: {} }],
    attributes: {},
    dimension_names: ["z", "y", "x"],
  });
}

const encoder = new TextEncoder();
const ROUTES: Record<string, Record<string, string>> = {
  [MULTI_URL]: { "zarr.json": MULTI_GROUP_JSON, "0/zarr.json": MULTI_ARRAY_JSON },
  [PLANE_URL]: { "zarr.json": PLANE_GROUP_JSON, "0/zarr.json": PLANE_ARRAY_JSON },
  [EMPTY_URL]: { "zarr.json": EMPTY_GROUP_JSON },
  [NOOMERO_URL]: { "zarr.json": NOOMERO_GROUP_JSON, "0/zarr.json": NOOMERO_ARRAY_JSON },
  [STRIDED_URL]: {
    "zarr.json": STRIDED_GROUP_JSON,
    "0/zarr.json": arrayJson([500, 256, 256], [1, 256, 256]),
    "1/zarr.json": arrayJson([500, 128, 128], [1, 128, 128]),
  },
};

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const href = String(input);
    for (const [base, files] of Object.entries(ROUTES)) {
      if (!href.startsWith(`${base}/`)) continue;
      const body = files[href.slice(base.length + 1)];
      if (body) return new Response(encoder.encode(body), { status: 200 });
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  });
}

async function openImage(url: string): Promise<ImageDataset> {
  const dataset = await openDataset({ type: "image", source: url });
  expect(dataset).toBeInstanceOf(ImageDataset);
  return dataset as ImageDataset;
}

describe("image dataset kind", () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves a 3D multichannel store into a normalized dataset", async () => {
    const dataset = await openImage(MULTI_URL);

    expect(dataset.type).toBe("image");
    expect(dataset.config).toEqual({ type: "image", source: MULTI_URL });
    expect(dataset.name).toBe("test-multichannel");
    expect(dataset.dtype).toBe("uint8");

    // Source runtime plugs directly into layer data configs.
    expect(dataset.pyramid.levels[0].shape).toEqual([8, 8, 4]);
    expect(typeof dataset.fetch).toBe("function");

    // Physical space: finest shape × voxel scale, μm normalized.
    expect(dataset.physical?.spatial.size).toEqual([4, 4, 8]);
    expect(dataset.physical?.spatial.spacing).toEqual([0.5, 0.5, 2]);
    expect(dataset.physical?.spatial.origin).toEqual([0, 0, 0]);
    expect(dataset.physical?.spatial.unit).toBe("μm");

    // Dimensions + default selection.
    expect(dataset.dimensions).toEqual([{ name: "c", size: 2, labels: ["DAPI", "GFP"] }]);
    expect(dataset.defaultSelection).toEqual({ c: 0 });

    // Channels: omero labels/colors normalized, window → normalized contrast,
    // active flags → visibility.
    expect(dataset.channels).toEqual([
      { index: 0, label: "DAPI", color: "#0000FF", contrast: [0.2, 0.6], visible: true },
      { index: 1, label: "GFP", color: "#00FF00", contrast: [0, 1], visible: false },
    ]);

    // Well-behaved 3D pyramid: volume preview without the budget policy.
    expect(dataset.capabilities).toEqual({
      zDepth: 4,
      supports3D: true,
      supportsVolumePreview: true,
    });
  });

  it("resolves a 2D store with default channels and no 3D capability", async () => {
    const dataset = await openImage(PLANE_URL);

    expect(dataset.dimensions).toEqual([]);
    expect(dataset.defaultSelection).toEqual({});
    // No omero metadata: one default channel, palette color, [0,1] contrast.
    expect(dataset.channels).toEqual([
      { index: 0, label: "Channel 0", color: "#00B0FF", contrast: [0, 1], visible: true },
    ]);
    expect(dataset.capabilities).toEqual({
      zDepth: 1,
      supports3D: false,
      supportsVolumePreview: false,
    });
  });

  it("multichannel without omero metadata: defaults, first channel visible", async () => {
    const dataset = await openImage(NOOMERO_URL);
    expect(dataset.channels).toEqual([
      { index: 0, label: "Channel 0", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "Channel 1", color: "#FF3D3D", contrast: [0, 1], visible: false },
      { index: 2, label: "Channel 2", color: "#7CFFB2", contrast: [0, 1], visible: false },
    ]);
  });

  it("z-chunk=1 dataset reports bounded volume preview capability (DX-M4 policy)", async () => {
    const dataset = await openImage(STRIDED_URL);
    expect(dataset.capabilities).toEqual({
      zDepth: 500,
      supports3D: true,
      supportsVolumePreview: true,
    });
  });

  it("rejects with an actionable error for unsupported metadata", async () => {
    const promise = openDataset({ type: "image", source: EMPTY_URL });
    await expect(promise).rejects.toThrow(
      /Failed to open OME-Zarr dataset at https:\/\/example\.test\/empty\.ome\.zarr: No OME-Zarr multiscales metadata found/,
    );
    await expect(promise).rejects.toHaveProperty("cause");
  });

  it("rejects when the config lacks a source", async () => {
    await expect(openDataset({ type: "image" })).rejects.toThrow(
      /requires a "source" URL string/,
    );
  });

  describe("deriveDefaults", () => {
    it("3D + volume-preview support resolves to volume mode", async () => {
      const dataset = await openImage(MULTI_URL);
      expect(dataset.deriveDefaults()).toEqual({ mode: "volume", selection: { c: 0 } });
    });

    it("2D resolves to slice mode", async () => {
      const dataset = await openImage(PLANE_URL);
      expect(dataset.deriveDefaults()).toEqual({ mode: "slice", selection: {} });
    });
  });

  describe("createDefaultLayers", () => {
    it("builds one additive volume layer per channel with projection", async () => {
      const dataset = await openImage(MULTI_URL);
      const layers = dataset.createDefaultLayers({
        view: "volume",
        prefix: "volume",
        channels: dataset.channels,
        projection: "mip",
      });

      expect(layers.map((layer) => layer.id)).toEqual(["volume-c0", "volume-c1"]);
      for (const [index, layer] of layers.entries()) {
        expect(layer.type).toBe("volume");
        expect(layer.data?.pyramid).toBe(dataset.pyramid);
        expect(layer.data?.fetch).toBe(dataset.fetch);
        expect(layer.data).not.toHaveProperty("transform");
        expect(layer.options?.selection).toEqual({ c: index });
        expect(layer.render?.blending).toBe("additive");
        expect(layer.render?.volumeProjection).toBe("mip");
      }
      // Channel color/contrast/visibility propagate from the dataset.
      expect(layers[0].render).toMatchObject({ visible: true, color: "#0000FF", contrastLimits: [0.2, 0.6] });
      expect(layers[1].render).toMatchObject({ visible: false, color: "#00FF00", contrastLimits: [0, 1] });
    });

    it("slice views get no volumeProjection", async () => {
      const dataset = await openImage(MULTI_URL);
      const layers = dataset.createDefaultLayers({
        view: "slice",
        prefix: "slice",
        channels: dataset.channels,
      });
      expect(layers.map((layer) => layer.id)).toEqual(["slice-c0", "slice-c1"]);
      expect(layers[0].type).toBe("slice");
      expect(layers[0].render?.volumeProjection).toBeUndefined();
      expect(layers[0].options).not.toHaveProperty("axes");
    });

    it("quad-plane prefixes carry the in-plane axes", async () => {
      const dataset = await openImage(MULTI_URL);
      const layers = dataset.createDefaultLayers({
        view: "slice",
        prefix: "quad-xz",
        axes: ["x", "z"],
        channels: dataset.channels,
      });
      expect(layers.map((layer) => layer.id)).toEqual(["quad-xz-c0", "quad-xz-c1"]);
      expect(layers[0].options?.axes).toEqual(["x", "z"]);
      expect(layers[1].options?.selection).toEqual({ c: 1 });
    });

    it("a mode transform is copied into each layer's data", async () => {
      const dataset = await openImage(MULTI_URL);
      const transform = [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1];
      const layers = dataset.createDefaultLayers({
        view: "volume",
        prefix: "volume",
        channels: dataset.channels,
        projection: "mip",
        transform,
      });
      for (const layer of layers) {
        expect(layer.data?.transform).toEqual(transform);
        expect(layer.data?.transform).not.toBe(transform);
      }
    });
  });
});
