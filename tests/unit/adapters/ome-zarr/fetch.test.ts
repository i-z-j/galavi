/**
 * Fetch tests against a deterministic in-memory OME-Zarr v3 store served
 * through a stubbed global fetch (no network).
 *
 * Covers:
 *   - successful fetchTile / fetchPlane decode and packing
 *   - out-of-bounds requests still resolving to zero-filled buffers
 *   - store/decode failures REJECTING with contextual errors
 *     (source URL, level, position, selection in the message)
 *   - custom fetch injection (options.fetch) routing every store request
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floatToFloat16 } from "../../../../src/index";
import { fetch2DPlane, openOMEZarr } from "../../../../src/dataset/adapters/ome-zarr";

const URL_BASE = "https://example.test/data.ome.zarr";

// Array "0": shape [c=1, z=4, y=8, x=8], chunks [1, 2, 4, 4], uint8.
const CHUNK = new Uint8Array(1 * 2 * 4 * 4).map((_, i) => i); // values 0..31

const GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
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
    },
  },
});

const ARRAY_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [1, 4, 8, 8],
  data_type: "uint8",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 2, 4, 4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: 0,
  codecs: [{ name: "bytes", configuration: {} }],
  attributes: {},
  dimension_names: ["c", "z", "y", "x"],
});

const encoder = new TextEncoder();

/** Paths (relative to URL_BASE) that should fail with a 500. */
const failingPaths = new Set<string>();

function storeFetch(input: RequestInfo | URL): Promise<Response> {
  const href = String(input);
  const path = href.slice(URL_BASE.length + 1); // after ".../data.ome.zarr/"
  if (failingPaths.has(path)) return Promise.resolve(new Response("boom", { status: 500 }));
  if (path === "zarr.json") return Promise.resolve(new Response(encoder.encode(GROUP_JSON), { status: 200 }));
  if (path === "0/zarr.json") return Promise.resolve(new Response(encoder.encode(ARRAY_JSON), { status: 200 }));
  if (path === "0/c/0/0/0/0") return Promise.resolve(new Response(CHUNK, { status: 200 }));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function stubFetch() {
  vi.stubGlobal("fetch", storeFetch);
}

beforeEach(() => {
  failingPaths.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTile", () => {
  it("decodes and packs a chunk into an x-fastest r16float tile", async () => {
    const info = await openOMEZarr(URL_BASE);
    const tile = await info.fetchTile({ level: 0, position: [0, 0, 0] });
    const words = new Uint16Array(tile);
    // chunkSize [x=4, y=4, z=2] -> 32 voxels; source values 0..31 in C order
    expect(words.length).toBe(32);
    for (let i = 0; i < 32; i++) expect(words[i]).toBe(floatToFloat16(i / 255));
  });

  it("resolves zero-filled buffers for out-of-bounds positions", async () => {
    const info = await openOMEZarr(URL_BASE);
    const tile = await info.fetchTile({ level: 0, position: [1000, 0, 0] });
    const words = new Uint16Array(tile);
    expect(words.length).toBe(32);
    expect([...words]).toEqual(new Array(32).fill(0));
  });

  it("rejects with context when the store fails", async () => {
    failingPaths.add("0/c/0/0/0/1");
    const info = await openOMEZarr(URL_BASE);
    const promise = info.fetchTile({ level: 0, position: [4, 0, 0], selection: { c: 0 } });
    await expect(promise).rejects.toThrowError(/fetchTile failed/);
    await expect(promise).rejects.toThrowError(/https:\/\/example\.test\/data\.ome\.zarr/);
    await expect(promise).rejects.toThrowError(/level 0/);
    await expect(promise).rejects.toThrowError(/position \[4, 0, 0\]/);
    await expect(promise).rejects.toThrowError(/selection \{"c":0\}/);
  });

  it("forwards an abort signal to the underlying chunk request", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const customFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/0/c/0/0/0/0")) receivedSignal = init?.signal;
      return storeFetch(input);
    }) as typeof globalThis.fetch;
    const info = await openOMEZarr(URL_BASE, { fetch: customFetch });
    const controller = new AbortController();

    await info.fetchTile({
      level: 0,
      position: [0, 0, 0],
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it("rejects a pre-aborted request without fetching its chunk", async () => {
    let chunkRequests = 0;
    const customFetch = ((input: RequestInfo | URL) => {
      if (String(input).endsWith("/0/c/0/0/0/0")) chunkRequests++;
      return storeFetch(input);
    }) as typeof globalThis.fetch;
    const info = await openOMEZarr(URL_BASE, { fetch: customFetch });
    const controller = new AbortController();
    controller.abort(new DOMException("superseded", "AbortError"));

    await expect(info.fetchTile({
      level: 0,
      position: [0, 0, 0],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(chunkRequests).toBe(0);
  });
});

describe("fetchPlane", () => {
  it("reads a single plane through the chunk", async () => {
    const plane = await fetch2DPlane(URL_BASE, [0, 1, 2]); // u = x, v = y, through = z
    const buffer = await plane.fetch({ level: 0, position: [0, 0, 1], selection: { c: 0 } });
    const words = new Uint16Array(buffer);
    // tile [x=4, y=4, z=1]; z = 1 plane of the chunk: values 16..31 (y, x C order)
    expect(words.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(words[i]).toBe(floatToFloat16((16 + i) / 255));
  });

  it("resolves zero-filled buffers for out-of-bounds plane indices", async () => {
    const plane = await fetch2DPlane(URL_BASE, [0, 1, 2]);
    const buffer = await plane.fetch({ level: 0, position: [0, 0, 100], selection: { c: 0 } });
    expect([...new Uint16Array(buffer)]).toEqual(new Array(16).fill(0));
  });

  it("rejects with context when the store fails", async () => {
    failingPaths.add("0/c/0/0/0/0");
    const plane = await fetch2DPlane(URL_BASE, [0, 1, 2]);
    const promise = plane.fetch({ level: 0, position: [0, 0, 1], selection: { c: 0 } });
    await expect(promise).rejects.toThrowError(/fetchPlane failed/);
    await expect(promise).rejects.toThrowError(/https:\/\/example\.test\/data\.ome\.zarr/);
    await expect(promise).rejects.toThrowError(/level 0/);
    await expect(promise).rejects.toThrowError(/position \[0, 0, 1\]/);
    await expect(promise).rejects.toThrowError(/selection \{"c":0\}/);
  });
});

describe("custom fetch", () => {
  /**
   * Counting wrapper around the in-memory store. The global fetch is replaced
   * with a throwing stub, so a successful read proves every store request
   * went through the injected fetcher.
   */
  function countingFetch() {
    let calls = 0;
    const fetchFn: typeof globalThis.fetch = async (input, _init) => {
      calls++;
      return storeFetch(input);
    };
    vi.stubGlobal("fetch", () => Promise.reject(new Error("global fetch must not be used")));
    return { fetchFn, calls: () => calls };
  }

  it("openOMEZarr routes store requests through options.fetch", async () => {
    const custom = countingFetch();
    const info = await openOMEZarr(URL_BASE, { fetch: custom.fetchFn });
    const tile = await info.fetchTile({ level: 0, position: [0, 0, 0] });
    expect(new Uint16Array(tile).length).toBe(32);
    expect(custom.calls()).toBeGreaterThan(0);
  });

  it("fetch2DPlane routes store requests through options.fetch", async () => {
    const custom = countingFetch();
    const plane = await fetch2DPlane(URL_BASE, [0, 1, 2], { fetch: custom.fetchFn });
    const buffer = await plane.fetch({ level: 0, position: [0, 0, 1], selection: { c: 0 } });
    expect(new Uint16Array(buffer).length).toBe(16);
    expect(custom.calls()).toBeGreaterThan(0);
  });
});
