/**
 * DatasetConfigMap typing tests (API-2) — the compile-time contract of
 * dataset loader identities.
 *
 * The `bun run typecheck` gate compiles this file (tsconfig.test.json):
 * `@ts-expect-error` lines must error, everything else must compile. The
 * runtime test proves the fixtures stay pure JSON and that the built-in,
 * augmented, and third-party-style kinds coexist in one registry.
 *
 * `../src/dataset/ome-zarr` is imported for its `DatasetConfigMap`
 * augmentation, mirroring a consumer's `import "galavi/ome-zarr"`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Dataset,
  openDataset,
  registerDataset,
  type DatasetConfig,
} from "../src/index";
import { datasetRegistry } from "../src/registry";
import type { LayerConfig } from "../src/types";
import "../src/dataset/ome-zarr";

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
 * A second image format identifies as its own loader, never the generic
 * `"image"`: two image kinds coexist because each owns an exact config key.
 */
declare module "galavi" {
  interface DatasetConfigMap {
    "ome-tiff": { type: "ome-tiff"; source: string };
  }
}

class TiffStubDataset extends Dataset {
  override async load(): Promise<void> {}
  override dispose(): void {}
  override createDefaultLayers(): LayerConfig[] {
    return [];
  }
}

// Registering an augmented kind types the factory config exactly.
registerDataset("ome-tiff", (config) => {
  const source: string = config.source; // exactly typed — not `unknown`
  void source;
  return new TiffStubDataset(config);
});

function typeProbes(): void {
  // @ts-expect-error — registerDataset rejects kinds missing from DatasetConfigMap
  registerDataset("unregistered-probe", (config) => new TiffStubDataset(config));
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

  test("OME-Zarr, mesh, and an OME-TIFF fixture coexist in one registry", () => {
    expect(datasetRegistry.keys()).toEqual(
      expect.arrayContaining(["mesh", "ome-zarr", "ome-tiff"]),
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
});
