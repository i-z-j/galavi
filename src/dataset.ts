/**
 * Dataset resolution — the format-neutral resolved-dataset contract (DX-M1).
 *
 * `Data.source` descriptors resolve render artifacts per layer through
 * `sourceRegistry`, but nothing in that path produces a viewer-ready dataset:
 * physical space stays a hint, channels are absent, and N layers over one
 * store re-open the same metadata. This module layers OVER the source
 * registry (which stays untouched): format adapters register a
 * {@link DatasetResolver} keyed by the same source-type string, and
 * {@link openDataset} resolves a {@link ResolvedDataset} ONCE per source
 * identity and caches it so every layer over the dataset shares one metadata
 * open.
 *
 * The contract is format-neutral: no OME-Zarr/OMERO concepts appear here —
 * adapters map their native metadata into this shape. Deriving today's layer
 * configs from a resolved dataset is trivial:
 *
 * ```ts
 * const dataset = await openDataset({ type: "ome-zarr", url });
 * const layer: VolumeLayerConfig = {
 *   id: "volume-c0",
 *   type: "volume",
 *   data: { pyramid: dataset.pyramid, fetch: dataset.fetch },
 *   options: { selection: { ...dataset.defaultSelection, c: 0 } },
 * };
 * ```
 *
 * Serialization: every field except `fetch` is plain JSON (`source`,
 * `pyramid`, `physical`, `dimensions`, `defaultSelection`, `channels`,
 * `dtype`, `capabilities`). `fetch` is an imperative runtime resource and is
 * never serialized — the `source` descriptor is the canonical serializable
 * form, mirroring the `Data.source` policy.
 */

import { Registry } from "./registry";
import type {
  Data,
  ImagePyramid,
  PhysicalSpace,
  SourceDescriptor,
  Vec2,
} from "./types";
import { planVolumePreview } from "./utils/tile/volume-policy";

// ============================================================================
// RESOLVED DATASET CONTRACT
// ============================================================================

/**
 * One normalized channel: render-ready color (`#RRGGBB`), contrast window in
 * normalized units, and initial visibility. Built from format metadata where
 * present, from galavi defaults otherwise (see the metadata/default policy in
 * `engineering-cleanup-plan.md` §16).
 */
export interface ResolvedChannel {
  /** Channel index — the `c` selection value for per-channel layers. */
  index    : number;
  /** Display label (metadata label, else `Channel N`). */
  label    : string;
  /** Display color, normalized `#RRGGBB` uppercase. */
  color    : string;
  /** Contrast window, normalized and clamped to [0, 1]. */
  contrast : Vec2;
  /** Initial visibility (metadata active flag; else first channel only). */
  visible  : boolean;
}

/** A non-spatial selection dimension (e.g. channel, timepoint). */
export interface DatasetDimension {
  name    : string;
  size    : number;
  labels? : string[];
}

/**
 * What the dataset can drive, derived from pyramid/chunk metadata alone.
 * Lets `mode: "auto"` ask "can volume produce a valid bounded preview"
 * without opening a renderer (engineering-cleanup-plan.md §16).
 */
export interface DatasetCapabilities {
  /** Z depth of the finest pyramid level (1 for 2D sources). */
  zDepth                : number;
  /** z > 1 — 3D modes (volume/quad) are meaningful. */
  supports3D            : boolean;
  /**
   * Volume mode can produce a valid bounded preview: the pyramid is
   * well-behaved (renders directly) or the automatic tile-budget policy
   * (`planVolumePreview`, DX-M4) derives a bounded plan for it.
   */
  supportsVolumePreview : boolean;
}

/**
 * A dataset resolved once and shared across layers: the source runtime tiled
 * image layers consume (`pyramid` + `fetch`), physical space, non-spatial
 * dimensions with their default selection, normalized channels, dtype, and
 * capabilities. See the module doc for serialization rules.
 */
export interface ResolvedDataset {
  /** Canonical descriptor this dataset was resolved from (JSON-serializable). */
  source           : SourceDescriptor;
  /** Display name from source metadata, when present. */
  name?            : string;
  /** Multiscale pyramid metadata — plugs into `Data.pyramid`. */
  pyramid          : ImagePyramid;
  /** Tile fetcher — plugs into `Data.fetch` (runtime, not serializable). */
  fetch            : NonNullable<Data["fetch"]>;
  /** Physical space derived from the finest level and axis metadata. */
  physical         : PhysicalSpace;
  /** Non-spatial selection dimensions. */
  dimensions       : DatasetDimension[];
  /** Default index per non-spatial dimension (index 0 unless metadata says otherwise). */
  defaultSelection : Record<string, number>;
  /** Normalized channels — at least one, even for single-channel stores. */
  channels         : ResolvedChannel[];
  /** Storage dtype string, as reported by the source format. */
  dtype            : string;
  capabilities     : DatasetCapabilities;
}

// ============================================================================
// CAPABILITIES
// ============================================================================

/**
 * Derive dataset capabilities from pyramid/chunk metadata, reusing the
 * DX-M4 tile-budget policy semantics: `planVolumePreview` returns `null` for
 * well-behaved pyramids (they render directly — a valid preview) and a
 * bounded plan for pathological ones, so every non-empty 3D pyramid reports
 * volume-preview support.
 */
export function getDatasetCapabilities(pyramid: ImagePyramid): DatasetCapabilities {
  const zDepth = pyramid.levels[0]?.shape[2] ?? 0;
  const supports3D = zDepth > 1;
  if (!supports3D) {
    return { zDepth, supports3D, supportsVolumePreview: false };
  }
  const plan = planVolumePreview(pyramid);
  // null → well-behaved, volume renders the pyramid directly; plan → bounded.
  return {
    zDepth,
    supports3D,
    supportsVolumePreview: plan === null || plan.maxTiles > 0,
  };
}

// ============================================================================
// RESOLVER REGISTRY + CACHE
// ============================================================================

/**
 * DatasetResolver — turns a declarative {@link SourceDescriptor} into a
 * viewer-ready {@link ResolvedDataset}. Adapters register one per source type
 * (mirroring `registerSource`); resolvers must reject with actionable errors.
 */
export type DatasetResolver = (desc: SourceDescriptor) => Promise<ResolvedDataset>;

/** Registry of dataset resolvers keyed by source type. No built-ins. */
export const datasetResolverRegistry = new Registry<Promise<ResolvedDataset>, DatasetResolver>(
  () => ({}),
);

/**
 * Register a dataset resolver for a source type — the dataset-level
 * counterpart of `registerSource`. Adapter registration entry points (e.g.
 * `registerOMEZarrSource()`) register both.
 */
export function registerDatasetResolver(type: string, resolver: DatasetResolver): void {
  datasetResolverRegistry.register(type, resolver);
}

/**
 * Source identity for caching: the source type plus the canonical `url`
 * string when present, else a key-order-stable serialization of the whole
 * descriptor (functions and `undefined` values are dropped). Two descriptors
 * with the same identity share one resolution.
 */
export function datasetCacheKey(source: SourceDescriptor): string {
  if (typeof source.url === "string") return `${source.type}\n${source.url}`;
  return `${source.type}\n${stableStringify(source)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** In-flight and settled resolutions, keyed by {@link datasetCacheKey}. */
const datasetCache = new Map<string, Promise<ResolvedDataset>>();

/**
 * Resolve a source descriptor into a viewer-ready dataset, dispatching
 * through {@link datasetResolverRegistry}. Resolution happens ONCE per source
 * identity (see {@link datasetCacheKey}): repeated and concurrent opens of
 * the same source share one cached promise, so N layers over one dataset
 * never re-open metadata. Rejections are NOT cached — a failed open can be
 * retried, and a resolved entry can be dropped via {@link invalidateDataset}.
 *
 * Rejects with an actionable error when no resolver is registered for the
 * source type; resolver errors (network/CORS, unsupported metadata) reject
 * as-is — they are plumbed through, never swallowed.
 */
export function openDataset(source: SourceDescriptor): Promise<ResolvedDataset> {
  if (!source || typeof source.type !== "string" || source.type.length === 0) {
    return Promise.reject(
      new Error(`openDataset requires a source descriptor with a "type" string, got: ${JSON.stringify(source)}`),
    );
  }
  const key = datasetCacheKey(source);
  const cached = datasetCache.get(key);
  if (cached) return cached;

  if (!datasetResolverRegistry.has(source.type)) {
    const registered = datasetResolverRegistry.keys().join(", ") || "none";
    return Promise.reject(new Error(
      `Unknown dataset source type: "${source.type}" (registered: ${registered}). ` +
      `Register a resolver first — e.g. registerOMEZarrSource() from @galavi/ome-zarr-adapter.`,
    ));
  }

  const promise = Promise.resolve().then(() =>
    datasetResolverRegistry.create(source.type, source),
  );
  datasetCache.set(key, promise);
  // A rejected open is evicted so callers can retry after fixing the cause.
  promise.catch(() => {
    if (datasetCache.get(key) === promise) datasetCache.delete(key);
  });
  return promise;
}

/**
 * Drop the cached resolution for one source identity, so the next
 * {@link openDataset} re-resolves. Returns true when an entry was removed.
 * The previously returned dataset stays usable by existing holders — this
 * only detaches it from the cache.
 */
export function invalidateDataset(source: SourceDescriptor): boolean {
  return datasetCache.delete(datasetCacheKey(source));
}

/** Drop every cached resolution (e.g. on app-level teardown). */
export function invalidateAllDatasets(): void {
  datasetCache.clear();
}
