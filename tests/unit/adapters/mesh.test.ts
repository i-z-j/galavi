/**
 * MeshDataset tests — the `"mesh"` dataset kind (OBJ), registered by the
 * idempotent `ensureBuiltInDatasets()` bootstrap that `openDataset` invokes
 * (the core import chain alone registers nothing — no import side effects).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MeshDataset,
  openDataset,
} from "../../../src/index";
import { ensureBuiltInDatasets } from "../../../src/dataset";
import { datasetRegistry } from "../../../src/registry";

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

function stubFetch(body: string, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok     : status >= 200 && status < 300,
    status,
    text   : async () => body,
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MeshDataset", () => {
  test('"mesh" is registered by the built-in bootstrap', () => {
    ensureBuiltInDatasets();
    ensureBuiltInDatasets(); // idempotent: double-invocation is a no-op
    expect(datasetRegistry.has("mesh")).toBe(true);
  });

  test("openDataset loads the OBJ, derives metadata from the AABB, and exposes the primary mesh resource", async () => {
    stubFetch(OBJ);
    const dataset = await openDataset({ type: "mesh", source: "mem://mesh.obj" });
    expect(dataset).toBeInstanceOf(MeshDataset);

    // Physical space frames the mesh AABB (camera fit keys off it).
    expect(dataset.physical?.spatial.size).toEqual([10, 20, 30]);
    expect(dataset.physical?.spatial.origin).toEqual([0, 0, 0]);
    expect(dataset.channels).toEqual([]);
    expect(dataset.dimensions).toEqual([]);
    expect(dataset.defaultSelection).toEqual({});

    // One primary "mesh" resource: source identity plus the parsed geometry
    // (one network request and one parse per open — a surface layer
    // adopts the geometry, it never fetches the URL itself).
    expect(dataset.resources).toHaveLength(1);
    expect(dataset.primaryResourceId).toBe("mesh");
    const resource = dataset.resource("mesh");
    expect(resource).toBe(dataset.resources[0]);
    expect(resource?.kind).toBe("mesh");
    expect(resource?.source).toBe("mem://mesh.obj");
    expect(resource?.geometry?.positions).toBeInstanceOf(Float32Array);
    expect(resource?.geometry?.vertexCount).toBe(12); // 4 triangles → 12 vertices

    // Disposal releases the loaded geometry and the resource set.
    dataset.dispose();
    expect(dataset.resources).toEqual([]);
    expect(dataset.primaryResourceId).toBeUndefined();
    expect(dataset.resource("mesh")).toBeUndefined();
  });

  test("a missing source rejects with a clear error", async () => {
    // @ts-expect-error — `source` is required by the typed config
    await expect(openDataset({ type: "mesh" })).rejects.toThrow(
      /MeshDataset requires a "source" URL string/,
    );
  });

  test("a failed fetch rejects", async () => {
    stubFetch("not found", 404);
    await expect(openDataset({ type: "mesh", source: "mem://nope.obj" })).rejects.toThrow(
      /Mesh fetch failed: 404/,
    );
  });
});

describe("openDataset kind hints", () => {
  test('the "ome-zarr" kind error hints at the subpath import that provides it', async () => {
    // This file never imports ../src/dataset/adapters/ome-zarr, so the kind is
    // unregistered in this module graph (the config type compiles because the
    // augmentation is compilation-wide).
    await expect(openDataset({ type: "ome-zarr", source: "x" })).rejects.toThrow(
      /Unknown dataset kind: "ome-zarr".*Did you mean to import "galavi\/ome-zarr"\?/,
    );
  });
});
