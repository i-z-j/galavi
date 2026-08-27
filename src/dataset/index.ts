/**
 * Dataset module — the single dataset/source extension point.
 *
 * Dataset kinds (e.g. `"mesh"`, `"ome-zarr"`) register an adapter via
 * `registerDatasetAdapter` (registry.ts); `openDataset` constructs and loads a
 * fresh {@link Dataset} per call — there is no caching, disposal is the
 * caller's job. Each kind owns its exact config in {@link DatasetConfigMap}
 * and its exact resource shapes in {@link DatasetResourceMap}.
 */

import {
  CapabilityResolutionError,
  datasetRegistry,
} from "../registry";
import {
  assertDatasetResources,
  type Dataset,
  type DatasetAdapter,
  type DatasetConfig,
} from "./contract";
import { MeshDataset } from "./adapters/mesh";

export { Dataset } from "./contract";
export type {
  DatasetAdapter,
  DatasetChannel,
  DatasetConfig,
  DatasetConfigMap,
  DatasetDimension,
  DatasetResource,
  DatasetResourceMap,
  ImagePyramidFetch,
  ImagePyramidResource,
  MeshResource,
} from "./contract";

// Channel vocabulary (colors + contrast limits) — dataset-side helpers for
// adapters and consumers normalizing channel metadata.
export {
  CHANNEL_FALLBACK_COLORS,
  CONTRAST_RANGE,
  normalizeHexColor,
  getChannelColor,
  clampContrastLimits,
  buildContrastLimits,
} from "./contract";

// The built-in mesh kind (registered by ensureBuiltInDatasets below; never
// import `./adapters/ome-zarr` here, it is the `galavi/ome-zarr` subpath entry).
export { MeshDataset, mesh } from "./adapters/mesh";

/**
 * Idempotent built-in bootstrap: registers the built-in `"mesh"` dataset
 * kind. Invoked by `openDataset` before resolving a kind; double-invocation
 * is a no-op. (`"ome-zarr"` is the documented exception: the
 * `galavi/ome-zarr` subpath self-registers on import.)
 */
export function ensureBuiltInDatasets(): void {
  if (!datasetRegistry.has("mesh")) {
    datasetRegistry.register("mesh", (config) => new MeshDataset(config));
  }
}

/**
 * Kinds that live outside the core entry: the unknown-kind error names the
 * import that provides them.
 */
const KIND_IMPORT_HINTS: Record<string, string> = {
  "ome-zarr": "galavi/ome-zarr",
};

/**
 * Open a dataset from its declarative config: dispatch through
 * `datasetRegistry`, then `load()`. Every call constructs and loads a fresh
 * Dataset — disposal is the caller's job. Rejects with a
 * {@link CapabilityResolutionError} for unknown kinds (naming the registered
 * kinds and the fix); kind load failures reject as-is. A loaded dataset whose
 * resource set violates the contract (duplicate IDs, a `primaryResourceId`
 * naming no resource) rejects with the invariant error.
 *
 * A direct `options.adapter` bypasses the registry entirely (no lookup, no
 * registration) — the one-off path for unregistered customization; `load()`
 * and the resource invariants still apply.
 */
export async function openDataset(
  config   : DatasetConfig,
  options? : { adapter?: DatasetAdapter },
): Promise<Dataset> {
  if (!config || typeof config.type !== "string" || config.type.length === 0) {
    throw new Error(
      `openDataset requires a config with a "type" string, got: ${JSON.stringify(config)}`,
    );
  }
  let adapter = options?.adapter;
  if (adapter === undefined) {
    ensureBuiltInDatasets();
    if (!datasetRegistry.has(config.type)) {
      const importHint = KIND_IMPORT_HINTS[config.type];
      throw new CapabilityResolutionError({
        kind      : "dataset kind",
        type      : config.type,
        available : datasetRegistry.keys(),
        hint      : importHint
          ? `Did you mean to import "${importHint}"?`
          : "Register a dataset kind first via registerDatasetAdapter().",
      });
    }
    adapter = datasetRegistry.resolve(config.type);
  }
  const dataset = adapter(config);
  await dataset.load();
  assertDatasetResources(dataset);
  return dataset;
}
