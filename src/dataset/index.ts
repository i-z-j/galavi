/**
 * Dataset module — the single dataset/source extension point.
 *
 * Dataset kinds (e.g. `"mesh"`, `"ome-zarr"`) register a factory via
 * `registerDataset` (registry.ts); `openDataset` constructs and loads a fresh
 * {@link Dataset} per call — there is no caching, disposal is the caller's
 * job. Each kind owns its exact config in {@link DatasetConfigMap}.
 */

import { datasetRegistry } from "../registry";
import type { Dataset, DatasetConfig } from "./base";

export { Dataset, getDatasetCapabilities } from "./base";
export type {
  DatasetCapabilities,
  DatasetChannel,
  DatasetConfig,
  DatasetConfigMap,
  DatasetDimension,
  DefaultLayersOptions,
} from "./base";

// The built-in mesh kind (its registration is a lazy datasetRegistry
// built-in — registry.ts; never import `./ome-zarr` here, it is the
// `galavi/ome-zarr` subpath entry).
export { MeshDataset, mesh } from "./mesh";

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
 * Dataset — disposal is the caller's job. Rejects with an actionable error
 * for unknown kinds; kind load failures reject as-is.
 */
export async function openDataset(config: DatasetConfig): Promise<Dataset> {
  if (!config || typeof config.type !== "string" || config.type.length === 0) {
    throw new Error(
      `openDataset requires a config with a "type" string, got: ${JSON.stringify(config)}`,
    );
  }
  if (!datasetRegistry.has(config.type)) {
    const registered = datasetRegistry.keys().join(", ") || "none";
    const hint = KIND_IMPORT_HINTS[config.type];
    throw new Error(
      `Unknown dataset kind: "${config.type}" (registered: ${registered}).` +
      (hint
        ? ` Did you mean to import "${hint}"?`
        : ` Register a dataset kind first via registerDataset().`),
    );
  }
  const dataset = datasetRegistry.create(config.type, config);
  await dataset.load();
  return dataset;
}
