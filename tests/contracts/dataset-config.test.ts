/**
 * DatasetConfigMap typing tests — the compile-time contract of
 * dataset loader identities.
 *
 * The `bun run typecheck` gate compiles this file (tsconfig.test.json):
 * `@ts-expect-error` lines must error, everything else must compile. The
 * runtime test proves the fixtures stay pure JSON and that the built-in,
 * augmented, and third-party-style kinds coexist in one registry.
 *
 * `../src/dataset/adapters/ome-zarr` is imported for its `DatasetConfigMap`
 * augmentation, mirroring a consumer's `import "galavi/ome-zarr"` — the
 * named `omeZarr` descriptor import evaluates the same module.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Dataset,
  mesh,
  openDataset,
  registerDatasetAdapter,
  type DatasetConfig,
} from "../../src/index";
import { datasetRegistry } from "../../src/registry";
import { ensureBuiltInDatasets } from "../../src/dataset";
import { omeZarr } from "../../src/dataset/adapters/ome-zarr";

// ============================================================================
// EXACT CONFIG TYPING (compile-time)
// ============================================================================

// The built-in loader config compiles exactly.
const meshConfig: DatasetConfig = { type: "mesh", source: "mem://mesh.obj" };

// The augmented OME-Zarr config compiles once the subpath is imported.
const omeZarrConfig: DatasetConfig = {
  type: "ome-zarr",
  source: "https://example.test/image.ome.zarr",
};

// The named descriptor helpers build exactly the DatasetConfigMap members.
const helperZarr: DatasetConfig = omeZarr("https://example.test/image.ome.zarr");
const helperMesh: DatasetConfig = mesh("mem://mesh.obj");

// @ts-expect-error — `source` is required
omeZarr();

// @ts-expect-error — `source` must be a string
omeZarr(42);

// @ts-expect-error — `source` must be a string
mesh(undefined);

// @ts-expect-error — descriptor helpers take no runtime options bag
mesh("mem://mesh.obj", { fetch: () => Promise.resolve(new ArrayBuffer(0)) });

// @ts-expect-error — `source` is required
const missingSource: DatasetConfig = { type: "ome-zarr" };

// @ts-expect-error — the field is `source`; `url` is not a config field
const urlInsteadOfSource: DatasetConfig = { type: "ome-zarr", url: "https://example.test/x" };

// @ts-expect-error — "image" was the old OME-Zarr key; it is not a loader identity
const staleImageKey: DatasetConfig = { type: "image", source: "https://example.test/x" };

// @ts-expect-error — unknown loader keys do not compile
const unknownKey: DatasetConfig = { type: "nope", source: "mem://x" };

// ============================================================================
// THIRD-PARTY KINDS (compile fixture + runtime coexistence)
// ============================================================================

/**
 * A fictional third-party format identifies as its own loader, never the
 * generic `"image"`: two image kinds coexist because each owns an exact
 * config key. This is a typing fixture only — no such format is supported.
 */
declare module "galavi" {
  interface DatasetConfigMap {
    "custom-format": { type: "custom-format"; source: string };
  }
}

class CustomFormatStubDataset extends Dataset {
  override async load(): Promise<void> {}
  override dispose(): void {}
}

// Registering an augmented kind types the factory config exactly.
registerDatasetAdapter("custom-format", (config) => {
  const source: string = config.source; // exactly typed — not `unknown`
  void source;
  return new CustomFormatStubDataset(config);
});

function typeProbes(): void {
  // @ts-expect-error — registerDatasetAdapter rejects kinds missing from DatasetConfigMap
  registerDatasetAdapter("unregistered-probe", (config) => new CustomFormatStubDataset(config));
}
void typeProbes; // compile-time probe only — never invoked

// ============================================================================
// RUNTIME
// ============================================================================

describe("DatasetConfigMap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("the exact configs are pure JSON", () => {
    const configs = [
      meshConfig,
      omeZarrConfig,
      missingSource,
      urlInsteadOfSource,
      staleImageKey,
      unknownKey,
    ];
    expect(JSON.parse(JSON.stringify(configs))).toEqual(configs);
  });

  test("the descriptor helpers return exact, JSON-pure configs", () => {
    expect(helperZarr).toEqual({ type: "ome-zarr", source: "https://example.test/image.ome.zarr" });
    expect(helperMesh).toEqual({ type: "mesh", source: "mem://mesh.obj" });
    expect(JSON.parse(JSON.stringify(helperZarr))).toEqual(helperZarr);
    expect(JSON.parse(JSON.stringify(helperMesh))).toEqual(helperMesh);
  });

  test("OME-Zarr, mesh, and a third-party format fixture coexist in one registry", () => {
    ensureBuiltInDatasets(); // "mesh" registers via the bootstrap, not on import
    expect(datasetRegistry.keys()).toEqual(
      expect.arrayContaining(["mesh", "ome-zarr", "custom-format"]),
    );
  });

  test("the augmented config dispatches to the OME-Zarr loader", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    // A plate field config (`{ type: "ome-zarr", source }`) is a DatasetConfig.
    const config: DatasetConfig = { ...omeZarrConfig };
    await expect(openDataset(config)).rejects.toThrow(/Failed to open OME-Zarr dataset/);
    await expect(
      // @ts-expect-error — "nope" is not a loader identity
      openDataset({ type: "nope", source: "mem://x" }),
    ).rejects.toThrow(/Unknown dataset kind: "nope"/);
  });

  test("helper descriptors dispatch to their loaders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    // The omeZarr descriptor reaches OMEZarrDataset (its wrapped open error)…
    await expect(openDataset(omeZarr("https://example.test/x.zarr"))).rejects.toThrow(
      /Failed to open OME-Zarr dataset/,
    );
    // …and the mesh descriptor reaches MeshDataset (its fetch failure).
    await expect(openDataset(mesh("mem://missing.obj"))).rejects.toThrow(/Mesh fetch failed: 404/);
  });
});
