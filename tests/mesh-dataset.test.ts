/**
 * MeshDataset tests — the `"mesh"` dataset kind (OBJ), self-registered via
 * the core import chain (importing ../src/index alone must register it).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MeshDataset,
  openDataset,
} from "../src/index";
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

    expect(dataset.capabilities).toEqual({
      zDepth: 1, supports3D: true, supportsVolumePreview: true,
    });
    expect(dataset.channels).toEqual([]);
    expect(dataset.dimensions).toEqual([]);
    expect(dataset.defaultSelection).toEqual({});
    expect(dataset.deriveDefaults()).toEqual({ mode: "volume", selection: {} });

    // One surface layer pointed at the source URL — the layer fetches/parses
    // the OBJ itself, fitted into the physical frame.
    const layers = dataset.createDefaultLayers({
      view: "volume", prefix: "volume", channels: [],
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe("volume-mesh");
    expect(layers[0].type).toBe("surface");
    expect(layers[0].data?.url).toBe("mem://mesh.obj");
    expect(layers[0].options).toEqual({ fitToUnitAABB: true });

    dataset.dispose();
  });

  test("a missing source rejects with a clear error", async () => {
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
  test('the "image" kind error hints at the out-of-core adapter import', async () => {
    await expect(openDataset({ type: "image", source: "x" })).rejects.toThrow(
      /Unknown dataset kind: "image".*Did you mean to import "galavi\/ome-zarr"\?/,
    );
  });
});
