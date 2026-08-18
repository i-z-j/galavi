/**
 * MeshDataset tests — the `"mesh"` dataset kind (OBJ), self-registered via
 * the core import chain (importing ../src/index alone must register it).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MeshDataset,
  openDataset,
} from "../src/advanced";
import { datasetRegistry } from "../src/registry";

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
  test('"mesh" is registered via the core entry alone', () => {
    expect(datasetRegistry.has("mesh")).toBe(true);
  });

  test("openDataset loads the OBJ and derives metadata from the AABB", async () => {
    stubFetch(OBJ);
    const dataset = await openDataset({ type: "mesh", source: "mem://mesh.obj" });
    expect(dataset).toBeInstanceOf(MeshDataset);

    // Physical space frames the mesh AABB (camera fit keys off it).
    expect(dataset.physical?.spatial.size).toEqual([10, 20, 30]);
    expect(dataset.physical?.spatial.origin).toEqual([0, 0, 0]);

    // A mesh is a volume-only presentation.
    expect(dataset.capabilities).toEqual({ modes: ["volume"], defaultMode: "volume" });
    expect(dataset.channels).toEqual([]);
    expect(dataset.dimensions).toEqual([]);
    expect(dataset.defaultSelection).toEqual({});

    // One surface layer handed the already-parsed geometry (ARCH-1: one
    // network request and one parse per open — the layer never fetches the
    // URL itself), fitted into the physical frame.
    const layers = dataset.createDefaultLayers({
      view: "volume", prefix: "volume", channels: [],
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe("volume-mesh");
    expect(layers[0].type).toBe("surface");
    expect(layers[0].data?.url).toBe("mem://mesh.obj");
    expect(layers[0].options).toEqual({ fitToUnitAABB: true });

    // The hand-off carries the parsed geometry (4 triangles → 12 vertices)…
    const geometry = layers[0].data?.geometry;
    expect(geometry?.positions).toBeInstanceOf(Float32Array);
    expect(geometry?.vertexCount).toBe(12);

    // …as a defensive copy: mutating the layer's positions must not corrupt
    // the geometry retained for the next scene rebuild.
    geometry!.positions[0] = 999;
    const relayered = dataset.createDefaultLayers({
      view: "volume", prefix: "volume", channels: [],
    });
    expect(relayered[0].data?.geometry?.positions[0]).toBe(0);

    dataset.dispose();
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
    // This file never imports ../src/dataset/ome-zarr, so the kind is
    // unregistered in this module graph (the config type compiles because the
    // augmentation is compilation-wide).
    await expect(openDataset({ type: "ome-zarr", source: "x" })).rejects.toThrow(
      /Unknown dataset kind: "ome-zarr".*Did you mean to import "galavi\/ome-zarr"\?/,
    );
  });
});
