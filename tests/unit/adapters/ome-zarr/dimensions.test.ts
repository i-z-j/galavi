/**
 * Dimensionality handling tests.
 *
 * Covers the image kind's 2D (XY-only) support and generic handling of absent/singleton
 * dimensions: missing z is synthesized, missing c/t still open, and size-1 non-spatial
 * axes are reported faithfully.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floatToFloat16 } from "../../../../src/index";
import { fetch2DPlane, openOMEZarr } from "../../../../src/dataset/adapters/ome-zarr";

const encoder = new TextEncoder();
const BYTES_CODEC = [{ name: "bytes", configuration: {} }];

function makeStoreFetch(
  urlBase: string,
  groupJson: string,
  arrayJson: string,
  chunks: Record<string, Uint8Array>,
) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const href = String(input);
    const path = href.slice(urlBase.length + 1); // after ".../<base>/"
    if (path === "zarr.json") return new Response(encoder.encode(groupJson), { status: 200 });
    if (path === "0/zarr.json") return new Response(encoder.encode(arrayJson), { status: 200 });
    if (chunks[path]) {
      const chunk = chunks[path];
      if (chunk) return new Response(new Uint8Array(chunk), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function makeGroupJson(axes: Array<{ name: string; type?: string; unit?: string }>, scale: number[]) {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "group",
    attributes: {
      ome: {
        version: "0.5",
        multiscales: [{
          name: "test",
          axes,
          datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale }] }],
        }],
      },
    },
  });
}

function makeArrayJson(shape: number[], chunkShape: number[], dtype: string, dimensionNames: string[]) {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dtype,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunkShape } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0,
    codecs: BYTES_CODEC,
    attributes: {},
    dimension_names: dimensionNames,
  });
}

function makeChunk(values: number[]) {
  return new Uint8Array(values);
}

function expectTileValues(tile: ArrayBuffer, values: number[]) {
  const words = new Uint16Array(tile);
  expect(words.length).toBe(values.length);
  for (let i = 0; i < values.length; i++) {
    expect(words[i]).toBe(floatToFloat16(values[i] / 255));
  }
}

function valueGrid(start: number) {
  // 4x4 tile: 16 consecutive values starting at `start`
  return Array.from({ length: 16 }, (_, i) => start + i);
}

beforeEach(() => vi.stubGlobal("fetch", () => Promise.resolve(new Response("not found", { status: 404 }))));
afterEach(() => vi.unstubAllGlobals());

describe("2D [c, y, x] dataset", () => {
  const URL_BASE = "https://example.test/cyxy.ome.zarr";
  const CHUNK0 = makeChunk(valueGrid(0));
  const CHUNK1 = makeChunk(valueGrid(100));
  const GROUP = makeGroupJson(
    [{ name: "c", type: "channel" }, { name: "y", type: "space", unit: "micrometer" }, { name: "x", type: "space", unit: "micrometer" }],
    [1, 0.5, 0.5],
  );
  const ARRAY = makeArrayJson([2, 8, 8], [1, 4, 4], "uint8", ["c", "y", "x"]);
  const CHUNKS: Record<string, Uint8Array> = {
    "0/c/0/0/0": CHUNK0,
    "0/c/1/0/0": CHUNK1,
  };

  beforeEach(() => vi.stubGlobal("fetch", makeStoreFetch(URL_BASE, GROUP, ARRAY, CHUNKS)));

  it("synthesizes a singleton z axis and reports 3D XYZ pyramid", async () => {
    const info = await openOMEZarr(URL_BASE);
    expect(info.pyramid.levels[0].shape).toEqual([8, 8, 1]);
    expect(info.pyramid.levels[0].chunkSize).toEqual([4, 4, 1]);
    expect(info.pyramid.levels[0].scale).toEqual([0.5, 0.5, 0.5]);
    expect(info.spatialUnits).toEqual(["micrometer", "micrometer", "micrometer"]);
    expect(info.origin).toEqual([0, 0, 0]);
  });

  it("exposes c as a selection dim with omero labels/colors/contrast", async () => {
    const GROUP_WITH_OMERO = JSON.stringify({
      zarr_format: 3,
      node_type: "group",
      attributes: {
        ome: {
          version: "0.5",
          multiscales: [{
            name: "test",
            axes: [{ name: "c", type: "channel" }, { name: "y", type: "space", unit: "micrometer" }, { name: "x", type: "space", unit: "micrometer" }],
            datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 0.5, 0.5] }] }],
          }],
          omero: {
            channels: [
              { active: true, color: "FF0000", label: "red", window: { start: 0, end: 255, min: 0, max: 255 } },
              { active: true, color: "00FF00", label: "green", window: { start: 0, end: 128, min: 0, max: 255 } },
            ],
          },
        },
      },
    });
    vi.stubGlobal("fetch", makeStoreFetch(URL_BASE, GROUP_WITH_OMERO, ARRAY, CHUNKS));
    const info = await openOMEZarr(URL_BASE);
    expect(info.selectionDims).toHaveLength(1);
    expect(info.selectionDims[0]).toMatchObject({ name: "c", size: 2, labels: ["red", "green"], colors: ["FF0000", "00FF00"] });
    expect(info.defaultSelection).toEqual({ c: 0 });
    expect(info.omeroChannelLabels).toEqual(["red", "green"]);
    expect(info.omeroChannelActives).toEqual([true, true]);
  });

  it("fetches the correct channel plane", async () => {
    const info = await openOMEZarr(URL_BASE);
    const tile = await info.fetchTile({ level: 0, position: [0, 0, 0], selection: { c: 1 } });
    expectTileValues(tile, valueGrid(100));
  });

  it("returns a zeroed tile for z > 0 on a 2D dataset", async () => {
    const info = await openOMEZarr(URL_BASE);
    const tile = await info.fetchTile({ level: 0, position: [0, 0, 1], selection: { c: 0 } });
    const words = new Uint16Array(tile);
    expect(words.length).toBe(16);
    expect([...words]).toEqual(new Array(16).fill(0));
  });

  it("fetch2DPlane works with the default [0,1,2] axisMap", async () => {
    const plane = await fetch2DPlane(URL_BASE, [0, 1, 2]);
    const tile = await plane.fetch({ level: 0, position: [0, 0, 0], selection: { c: 1 } });
    expectTileValues(tile, valueGrid(100));
  });
});

describe("2D [y, x] dataset with no channels", () => {
  const URL_BASE = "https://example.test/xy.ome.zarr";
  const CHUNK = makeChunk(valueGrid(0));
  const GROUP = makeGroupJson(
    [{ name: "y", type: "space", unit: "micrometer" }, { name: "x", type: "space", unit: "micrometer" }],
    [0.5, 0.5],
  );
  const ARRAY = makeArrayJson([8, 8], [4, 4], "uint8", ["y", "x"]);
  const CHUNKS: Record<string, Uint8Array> = { "0/c/0/0": CHUNK };

  beforeEach(() => vi.stubGlobal("fetch", makeStoreFetch(URL_BASE, GROUP, ARRAY, CHUNKS)));

  it("opens with no selection dims and synthesized z=1", async () => {
    const info = await openOMEZarr(URL_BASE);
    expect(info.selectionDims).toHaveLength(0);
    expect(info.defaultSelection).toEqual({});
    expect(info.pyramid.levels[0].shape).toEqual([8, 8, 1]);
    expect(info.pyramid.levels[0].chunkSize).toEqual([4, 4, 1]);
    expect(info.spatialUnits).toEqual(["micrometer", "micrometer", "micrometer"]);
  });

  it("fetchTile returns the single plane", async () => {
    const info = await openOMEZarr(URL_BASE);
    const tile = await info.fetchTile({ level: 0, position: [0, 0, 0] });
    expectTileValues(tile, valueGrid(0));
  });

  it("fetch2DPlane accepts the default axisMap on a true 2D dataset", async () => {
    const plane = await fetch2DPlane(URL_BASE, [0, 1, 2]);
    const tile = await plane.fetch({ level: 0, position: [0, 0, 0] });
    expectTileValues(tile, valueGrid(0));
  });
});

describe("3D [z, y, x] dataset without a c axis but with omero channels", () => {
  const URL_BASE = "https://example.test/zyx.ome.zarr";
  const CHUNK = makeChunk(valueGrid(0));
  const GROUP = JSON.stringify({
    zarr_format: 3,
    node_type: "group",
    attributes: {
      ome: {
        version: "0.5",
        multiscales: [{
          name: "test",
          axes: [
            { name: "z", type: "space", unit: "micrometer" },
            { name: "y", type: "space", unit: "micrometer" },
            { name: "x", type: "space", unit: "micrometer" },
          ],
          datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [2, 0.5, 0.5] }] }],
        }],
        omero: {
          channels: [{ active: true, color: "FFFFFF", label: "tdTomato", window: { start: 0, end: 100, min: 0, max: 255 } }],
        },
      },
    },
  });
  const ARRAY = makeArrayJson([4, 8, 8], [2, 4, 4], "uint8", ["z", "y", "x"]);
  const CHUNKS: Record<string, Uint8Array> = { "0/c/0/0/0": CHUNK };

  beforeEach(() => vi.stubGlobal("fetch", makeStoreFetch(URL_BASE, GROUP, ARRAY, CHUNKS)));

  it("parses omero channels even when c axis is absent", async () => {
    const info = await openOMEZarr(URL_BASE);
    expect(info.selectionDims).toHaveLength(0);
    expect(info.omeroChannelLabels).toEqual(["tdTomato"]);
    expect(info.omeroChannelColors).toEqual(["FFFFFF"]);
    expect(info.omeroChannelContrastLimits).toEqual([[0 / 255, 100 / 255]]);
  });
});

describe("Singleton [t, c, z, y, x] dataset", () => {
  const URL_BASE = "https://example.test/singleton.ome.zarr";
  const CHUNK = makeChunk(valueGrid(0));
  const GROUP = JSON.stringify({
    zarr_format: 3,
    node_type: "group",
    attributes: {
      ome: {
        version: "0.5",
        multiscales: [{
          name: "test",
          axes: [
            { name: "t", type: "time" },
            { name: "c", type: "channel" },
            { name: "z", type: "space", unit: "micrometer" },
            { name: "y", type: "space", unit: "micrometer" },
            { name: "x", type: "space", unit: "micrometer" },
          ],
          datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1, 0.5, 0.5] }] }],
        }],
      },
    },
  });
  const ARRAY = makeArrayJson([1, 1, 1, 8, 8], [1, 1, 1, 4, 4], "uint8", ["t", "c", "z", "y", "x"]);
  const CHUNKS: Record<string, Uint8Array> = { "0/c/0/0/0/0/0": CHUNK };

  beforeEach(() => vi.stubGlobal("fetch", makeStoreFetch(URL_BASE, GROUP, ARRAY, CHUNKS)));

  it("reports t and c as size-1 selection dims and keeps z size 1", async () => {
    const info = await openOMEZarr(URL_BASE);
    expect(info.pyramid.levels[0].shape).toEqual([8, 8, 1]);
    expect(info.selectionDims.map((d) => ({ name: d.name, size: d.size }))).toEqual([
      { name: "t", size: 1 },
      { name: "c", size: 1 },
    ]);
    expect(info.defaultSelection).toEqual({ t: 0, c: 0 });
  });

  it("fetchTile resolves with all singleton selections", async () => {
    const info = await openOMEZarr(URL_BASE);
    const tile = await info.fetchTile({ level: 0, position: [0, 0, 0], selection: { t: 0, c: 0 } });
    expectTileValues(tile, valueGrid(0));
  });
});

describe("missing required axes still throws", () => {
  it("throws when x is absent", async () => {
    const GROUP = makeGroupJson([{ name: "y", type: "space" }, { name: "z", type: "space" }], [1, 1]);
    const ARRAY = makeArrayJson([1, 1], [1, 1], "uint8", ["y", "z"]);
    const URL = "https://example.test/missing-x.ome.zarr";
    vi.stubGlobal("fetch", makeStoreFetch(URL, GROUP, ARRAY, {}));
    await expect(openOMEZarr(URL)).rejects.toThrow(/Expected x\/y spatial axes/);
  });

  it("throws when y is absent", async () => {
    const GROUP = makeGroupJson([{ name: "x", type: "space" }, { name: "z", type: "space" }], [1, 1]);
    const ARRAY = makeArrayJson([1, 1], [1, 1], "uint8", ["x", "z"]);
    const URL = "https://example.test/missing-y.ome.zarr";
    vi.stubGlobal("fetch", makeStoreFetch(URL, GROUP, ARRAY, {}));
    await expect(openOMEZarr(URL)).rejects.toThrow(/Expected x\/y spatial axes/);
  });
});
