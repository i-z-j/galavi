/**
 * Dataset contract — the single module every dataset kind implements against:
 * the abstract {@link Dataset} base, the normalized channel/dimension
 * vocabulary, the channel color/contrast helpers adapters use to normalize
 * format metadata, and the augmentable runtime {@link DatasetResourceMap}.
 *
 * Terminology: the galavi abstraction is called a Dataset. OME-NGFF calls
 * pyramid/resolution levels "datasets" — in this module those are always
 * "resolution level" / "pyramid level" / "multiscale level", never "dataset".
 *
 * A Dataset owns source IO and exposes normalized metadata (channels,
 * dimensions, physical space) plus runtime data RESOURCES
 * ({@link DatasetResource}): what can be read, in a form compositions
 * translate into scenes. A Dataset never names viewer modes, builds layers,
 * or picks projections — those are the composition layer's jobs
 * (`src/viewer/compositions/*`, driven by the Viewer). Runtime functions and
 * parsed geometry live on the instance and are released via
 * {@link Dataset.dispose}; the {@link DatasetConfig} it was created from
 * stays pure JSON.
 *
 * Dependency rule: this module imports the portable vocabulary from
 * `state/schema.ts` only — never layers, viewers, or the registry.
 */

import type {
  DatasetConfig,
  ImagePyramid,
  PhysicalSpace,
  SurfaceGeometry,
  Vec2,
} from "../state/schema";

// The portable descriptor vocabulary lives in state/schema.ts (it is part of
// the scene document schema); re-exported here so `dataset/*` and registry
// imports keep working. The `galavi/ome-zarr` module augmentation of
// DatasetConfigMap targets `../../state/schema` directly.
export type { DatasetConfig, DatasetConfigMap } from "../state/schema";

// ============================================================================
// CHANNEL VOCABULARY
// ============================================================================
//
// Biomedical channel colors and contrast-limit math. Adapters (e.g. OME-Zarr)
// surface raw channel metadata (labels, hex colors, contrast windows); these
// helpers normalize it into render-ready values. One unified fallback palette
// covers missing or malformed metadata.

/**
 * One normalized channel: render-ready color (`#RRGGBB`), contrast window in
 * normalized units, and initial visibility. Built from format metadata where
 * present, from galavi defaults otherwise.
 */
export interface DatasetChannel {
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

/** Fallback channel colors, cycled by channel index. */
export const CHANNEL_FALLBACK_COLORS = [
  "#00B0FF",
  "#FF3D3D",
  "#7CFFB2",
  "#FFD23D",
  "#C792FF",
  "#FF9F45",
];

/** Normalized contrast window bounds. */
export const CONTRAST_RANGE: Vec2 = [0, 1];

/** Normalize a hex color to `#RRGGBB` uppercase; undefined when malformed. */
export function normalizeHexColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const normalized = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;
  return `#${normalized.toUpperCase()}`;
}

/**
 * Resolve a channel's display color: the adapter-supplied metadata color when
 * valid, otherwise a fallback palette entry (cycled by index).
 */
export function getChannelColor(index: number, metadataColor?: string): string {
  return normalizeHexColor(metadataColor)
    ?? CHANNEL_FALLBACK_COLORS[index % CHANNEL_FALLBACK_COLORS.length];
}

/** Clamp contrast limits into the normalized [0,1] range, ordered low ≤ high. */
export function clampContrastLimits(limits: readonly [number, number] | undefined): Vec2 {
  const rawLow  = limits?.[0];
  const rawHigh = limits?.[1];
  const low     = Number.isFinite(rawLow)  ? Math.max(0, Math.min(1, rawLow!))  : 0;
  const high    = Number.isFinite(rawHigh) ? Math.max(low, Math.min(1, rawHigh!)) : 1;
  return [low, high];
}

/**
 * Build per-channel contrast limits from adapter metadata (e.g. OME-Zarr
 * `omeroChannelContrastLimits`), clamped into [0,1] with [0,1] fallback.
 */
export function buildContrastLimits(
  channelContrastLimits : readonly (readonly [number, number] | undefined)[] | undefined,
  count                 : number,
): Vec2[] {
  return Array.from(
    { length: count },
    (_, index) => clampContrastLimits(channelContrastLimits?.[index]),
  );
}

// ============================================================================
// DATASET BASE
// ============================================================================

/**
 * Dataset — one opened data source with normalized metadata and typed runtime
 * resources. Subclasses are registered by kind via `registerDatasetAdapter`
 * and constructed + loaded through `openDataset`. Each open constructs and
 * loads a fresh instance; disposal is the caller's job.
 */
export abstract class Dataset {
  /** The dataset kind discriminator (from the config). */
  readonly type: string;
  /** The declarative config this dataset was opened from (pure JSON). */
  readonly config: DatasetConfig;

  /** Display name from source metadata, when present. */
  name?            : string;
  /** Physical space of the primary/common domain (drives the facade's camera fit). */
  physical?        : PhysicalSpace;
  /** Normalized channels of the primary domain — populated by subclasses during `load()`. */
  channels         : DatasetChannel[] = [];
  /** Non-spatial selection dimensions of the primary domain. */
  dimensions       : DatasetDimension[] = [];
  /** Default index per non-spatial dimension of the primary domain. */
  defaultSelection : Record<string, number> = {};

  private _resources: DatasetResource[] = [];
  private _primaryResourceId?: string;

  constructor(config: DatasetConfig) {
    this.type = config.type;
    this.config = config;
  }

  /**
   * Runtime data resources populated by `load()` — what can be read, with
   * resource-specific metadata attached. Resource IDs are unique within the
   * Dataset. ASSIGN the array (never mutate it in place) so the invariants
   * are validated; assign `resources` before {@link primaryResourceId}, and
   * clear `primaryResourceId` before clearing `resources`.
   */
  get resources(): DatasetResource[] {
    return this._resources;
  }
  set resources(value: DatasetResource[]) {
    assertValidResourceSet(value, this._primaryResourceId, this.type);
    this._resources = value;
  }

  /**
   * Identifies the resource the common Viewer translates; advanced
   * compositions select any resource explicitly. Must name a member of
   * {@link resources} once resources are populated.
   */
  get primaryResourceId(): string | undefined {
    return this._primaryResourceId;
  }
  set primaryResourceId(value: string | undefined) {
    assertValidResourceSet(this._resources, value, this.type);
    this._primaryResourceId = value;
  }

  /** Perform source IO and populate the metadata fields above. */
  abstract load(): Promise<void>;

  /** Release runtime resources held by this dataset. */
  abstract dispose(): void;

  /**
   * Typed resource lookup. With an explicit `id`, returns the resource with
   * that ID (validating its kind), or undefined when no resource has it.
   * Without an `id`, returns the primary resource when its kind matches,
   * otherwise the sole matching resource — and throws an actionable ambiguity
   * error when several resources match and none is primary. Returns undefined
   * when nothing matches.
   */
  resource<K extends keyof DatasetResourceMap>(
    kind : K,
    id?  : string,
  ): DatasetResourceMap[K] | undefined {
    if (id !== undefined) {
      const found = this._resources.find((resource) => resource.id === id);
      if (found === undefined) return undefined;
      if (found.kind !== kind) {
        throw new Error(
          `dataset.resource("${kind}", "${id}"): resource "${id}" of dataset kind ` +
          `"${this.type}" is a "${found.kind}" resource — check the kind or the id`,
        );
      }
      return found as DatasetResourceMap[K];
    }
    const primary = this._resources.find((resource) => resource.id === this._primaryResourceId);
    if (primary?.kind === kind) return primary as DatasetResourceMap[K];
    const matches = this._resources.filter((resource) => resource.kind === kind);
    if (matches.length === 1) return matches[0] as DatasetResourceMap[K];
    if (matches.length > 1) {
      const ids = matches.map((resource) => `"${resource.id}"`).join(", ");
      throw new Error(
        `dataset.resource("${kind}") is ambiguous: dataset kind "${this.type}" has ` +
        `${matches.length} "${kind}" resources (${ids}) and none is the primary resource — ` +
        `pass an explicit id: dataset.resource("${kind}", id)`,
      );
    }
    return undefined;
  }
}

/**
 * Enforce the resource-set invariants on a loaded Dataset: unique resource
 * IDs and a `primaryResourceId` that names an existing resource. Called by
 * `openDataset` after `load()`; the field setters apply the same checks at
 * assignment time.
 */
export function assertDatasetResources(dataset: Dataset): void {
  assertValidResourceSet(dataset.resources, dataset.primaryResourceId, dataset.type);
}

/** DatasetAdapter — constructs a Dataset from its declarative config. */
export type DatasetAdapter = (config: DatasetConfig) => Dataset;

function assertValidResourceSet(
  resources         : readonly DatasetResource[],
  primaryResourceId : string | undefined,
  type              : string,
): void {
  const ids = new Set<string>();
  for (const resource of resources) {
    if (ids.has(resource.id)) {
      throw new Error(
        `Dataset kind "${type}": duplicate resource id "${resource.id}" — ` +
        "resource ids must be unique within a Dataset",
      );
    }
    ids.add(resource.id);
  }
  if (primaryResourceId !== undefined && !ids.has(primaryResourceId)) {
    throw new Error(
      `Dataset kind "${type}": primaryResourceId "${primaryResourceId}" matches no ` +
      `resource (resources: ${[...ids].map((id) => `"${id}"`).join(", ") || "none"}) — ` +
      "assign resources before primaryResourceId",
    );
  }
}

// ============================================================================
// RESOURCES — the normalized, augmentable runtime data contract
// ============================================================================
//
// A loaded Dataset exposes what can be READ as a list of typed resources:
// the runtime objects (pyramid/fetch pairs, parsed geometry) plus the
// resource-specific metadata needed to consume them. Resources describe data
// only — they never name viewer modes, layer IDs, controls, projections, or
// rendering choices; translating resources into a scene is the composition
// layer's job (`src/viewer/compositions/*`, driven by the Viewer).
//
// Runtime functions and parsed geometry are valid here: a loaded Dataset is
// not the portable document — only its {@link DatasetConfig} is.

/**
 * Resource identity map: each resource kind owns its exact shape here, keyed
 * by its `kind` discriminator. Augmentable for custom kinds — like
 * {@link DatasetConfigMap} — via module augmentation:
 *
 * ```ts
 * declare module "galavi" {
 *   interface DatasetResourceMap {
 *     "precomputed-plane": PrecomputedPlaneResource;
 *   }
 * }
 * ```
 *
 * Augmenting the map extends {@link DatasetResource} and types
 * `Dataset.resource(kind)` for the new kind. Built-in reference compositions
 * only claim support for the resource kinds they understand; unknown kinds
 * remain usable through the runtime-level `State.layers` path.
 */
export interface DatasetResourceMap {
  "image-pyramid": ImagePyramidResource;
  mesh: MeshResource;
}

/** Any registered resource kind's shape. */
export type DatasetResource = DatasetResourceMap[keyof DatasetResourceMap];

/**
 * Runtime tile/plane fetch of an image resource — the same signature a layer
 * `Data.fetch` consumes, so the pair plugs into tiled layers verbatim.
 */
export type ImagePyramidFetch = (options?: {
  level?: number;
  position?: number[];
  selection?: Record<string, number>;
  signal?: AbortSignal;
}) => Promise<ArrayBuffer>;

/**
 * A multiscale image source: the runtime pyramid/fetch pair plus the
 * resource-specific physical space, dimensions, selection defaults, and
 * channels needed to consume it. On a single-image Dataset these mirror the
 * Dataset-level metadata (the primary domain); a multi-resource Dataset may
 * retain distinct values per image when its sources differ.
 */
export interface ImagePyramidResource {
  /** Stable identity — unique within the owning Dataset. */
  id: string;
  kind: "image-pyramid";
  /** Normalized multiscale metadata — drops into layer `data.pyramid` as-is. */
  pyramid: ImagePyramid;
  /** Runtime tile fetch — drops into layer `data.fetch` as-is. */
  fetch: ImagePyramidFetch;
  /** This image's physical space (may differ from the Dataset's primary domain). */
  physical?: PhysicalSpace;
  /** Non-spatial selection dimensions of THIS image. */
  dimensions: DatasetDimension[];
  /** Default index per non-spatial dimension of THIS image. */
  defaultSelection: Record<string, number>;
  /** Normalized channels of THIS image. */
  channels: DatasetChannel[];
}

/**
 * A mesh source: source identity plus the loaded geometry when the Dataset
 * parsed it. A composite Dataset may expose a URL-backed mesh WITHOUT fetching
 * it merely to open image metadata — `geometry` then stays undefined and a
 * surface-style layer fetches/parses from `source` itself.
 */
export interface MeshResource {
  /** Stable identity — unique within the owning Dataset. */
  id: string;
  kind: "mesh";
  /** Source identity (the URL the geometry came from, or would come from). */
  source: string;
  /**
   * Parsed geometry when loaded — owned by the Dataset and released on
   * dispose. Consumers (surface-style layers) treat it as read-only and take
   * defensive copies: layer geometry normalization mutates positions.
   */
  geometry?: SurfaceGeometry;
}
