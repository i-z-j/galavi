/**
 * OMEZarrDataset ("ome-zarr" kind) tests.
 *
 * `src/dataset/adapters/ome-zarr.ts` self-registers the "ome-zarr" dataset kind on
 * module load, so `openDataset({ type: "ome-zarr", source })` resolves a
 * normalized OMEZarrDataset: channels (colors/labels/contrast/active),
 * physical space, default selection, and one primary `"image-pyramid"`
 * resource carrying the runtime pyramid/fetch pair. Composition support
 * (2D slice-only, 3D all-modes via the bounded-preview policy) is asserted
 * through the composition layer's `supportedCompositions`/`resolveAutoComposition`. Runs
 * against deterministic in-memory stores served through a stubbed global
 * fetch (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDataset } from "../../../../src/index";
import { OMEZarrDataset, openOMEZarr, openOMEZarrDataset } from "../../../../src/dataset/adapters/ome-zarr";
import { resolveAutoComposition, supportedCompositions } from "../../../../src/viewer/compositions";

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

// z-chunk=1 store two levels, metadata only.
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

async function openImage(url: string): Promise<OMEZarrDataset> {
  const dataset = await openDataset({ type: "ome-zarr", source: url });
  expect(dataset).toBeInstanceOf(OMEZarrDataset);
  return dataset as OMEZarrDataset;
}

describe("ome-zarr dataset kind", () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves a 3D multichannel store into a normalized dataset", async () => {
    const dataset = await openImage(MULTI_URL);

    expect(dataset.type).toBe("ome-zarr");
    expect(dataset.config).toEqual({ type: "ome-zarr", source: MULTI_URL });
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

    // One primary image-pyramid resource: the runtime pyramid/fetch pair plus
    // the normalized metadata compositions consume.
    expect(dataset.resources).toHaveLength(1);
    expect(dataset.primaryResourceId).toBe("image");
    const resource = dataset.resource("image-pyramid");
    expect(resource).toBe(dataset.resources[0]);
    expect(resource?.kind).toBe("image-pyramid");
    expect(resource?.pyramid).toBe(dataset.pyramid);
    expect(resource?.fetch).toBe(dataset.fetch);
    expect(resource?.physical).toBe(dataset.physical);
    expect(resource?.channels).toEqual(dataset.channels);
    expect(resource?.dimensions).toEqual(dataset.dimensions);
    expect(resource?.defaultSelection).toEqual(dataset.defaultSelection);

    // Well-behaved 3D pyramid: all three reference compositions support it,
    // and auto-mode resolves to volume.
    expect(supportedCompositions(dataset)).toEqual(["slice", "volume", "quad", "grid"]);
    expect(resolveAutoComposition(dataset)).toBe("volume");
  });

  it("resolves a 2D store with default channels and slice-only composition support", async () => {
    const dataset = await openImage(PLANE_URL);

    expect(dataset.dimensions).toEqual([]);
    expect(dataset.defaultSelection).toEqual({});
    // No omero metadata: one default channel, palette color, [0,1] contrast.
    expect(dataset.channels).toEqual([
      { index: 0, label: "Channel 0", color: "#00B0FF", contrast: [0, 1], visible: true },
    ]);
    expect(supportedCompositions(dataset)).toEqual(["slice", "grid"]);
    expect(resolveAutoComposition(dataset)).toBe("slice");
  });

  it("multichannel without omero metadata: defaults, first channel visible", async () => {
    const dataset = await openImage(NOOMERO_URL);
    expect(dataset.channels).toEqual([
      { index: 0, label: "Channel 0", color: "#00B0FF", contrast: [0, 1], visible: true },
      { index: 1, label: "Channel 1", color: "#FF3D3D", contrast: [0, 1], visible: false },
      { index: 2, label: "Channel 2", color: "#7CFFB2", contrast: [0, 1], visible: false },
    ]);
  });

  it("z-chunk=1 dataset still supports volume (bounded preview policy)", async () => {
    const dataset = await openImage(STRIDED_URL);
    expect(supportedCompositions(dataset)).toEqual(["slice", "volume", "quad", "grid"]);
    expect(resolveAutoComposition(dataset)).toBe("volume");
  });

  it("rejects with an actionable error for unsupported metadata", async () => {
    const promise = openDataset({ type: "ome-zarr", source: EMPTY_URL });
    await expect(promise).rejects.toThrow(
      /Failed to open OME-Zarr dataset at https:\/\/example\.test\/empty\.ome\.zarr: No OME-Zarr multiscales metadata found/,
    );
    await expect(promise).rejects.toHaveProperty("cause");
  });

  it("rejects when the config lacks a source", async () => {
    // @ts-expect-error — `source` is required by the typed config
    await expect(openDataset({ type: "ome-zarr" })).rejects.toThrow(
      /requires a "source" URL string/,
    );
  });

  describe("resource lookup", () => {
    it("finds the primary image resource by kind and by id; mesh is absent", async () => {
      const dataset = await openImage(MULTI_URL);
      expect(dataset.resource("image-pyramid")).toBe(dataset.resources[0]);
      expect(dataset.resource("image-pyramid", "image")).toBe(dataset.resources[0]);
      expect(dataset.resource("image-pyramid", "nope")).toBeUndefined();
      expect(dataset.resource("mesh")).toBeUndefined();
    });

    it("dispose releases the retained metadata and the resource set", async () => {
      const dataset = await openOMEZarrDataset(MULTI_URL);
      expect(dataset.resources).toHaveLength(1);
      dataset.dispose();
      expect(dataset.info).toBeUndefined();
      expect(dataset.resources).toEqual([]);
      expect(dataset.primaryResourceId).toBeUndefined();
      expect(dataset.resource("image-pyramid")).toBeUndefined();
    });
  });

  describe("OMEZarrDataset.info", () => {
    it("retains the parsed OMEZarrInfo — identical content to a fresh openOMEZarr", async () => {
      const dataset = await openImage(MULTI_URL);
      const info = dataset.info;
      expect(info).toBeDefined();
      // The very object load() obtained: the normalized fields alias into it.
      expect(info!.pyramid).toBe(dataset.pyramid);
      expect(info!.fetchTile).toBe(dataset.fetch);
      expect(info!.omeVersion).toBe("0.5");
      expect(info!.dtype).toBe("uint8");

      // Content parity with a fresh open of the same store (fetchTile is a
      // per-open closure — excluded from the comparison).
      const fresh = await openOMEZarr(MULTI_URL);
      const { fetchTile: _retained, ...rest } = info!;
      const { fetchTile: _fresh, ...expected } = fresh;
      expect(rest).toEqual(expected);
    });

    it("openOMEZarrDataset opens the store and loads the Dataset in one call", async () => {
      const dataset = await openOMEZarrDataset(MULTI_URL);
      expect(dataset).toBeInstanceOf(OMEZarrDataset);
      expect(dataset.config).toEqual({ type: "ome-zarr", source: MULTI_URL });
      expect(dataset.info).toBeDefined();
      expect(dataset.info!.omeroChannelLabels).toEqual(["DAPI", "GFP"]);
      expect(dataset.channels).toHaveLength(2);
      expect(dataset.resource("image-pyramid")).toBe(dataset.resources[0]);
      expect(resolveAutoComposition(dataset)).toBe("volume");

      dataset.dispose();
      expect(dataset.info).toBeUndefined(); // released with the other references
    });
  });
});
