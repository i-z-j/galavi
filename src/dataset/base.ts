/**
 * Dataset base — the abstract contract every dataset kind implements.
 *
 * Terminology: the galavi abstraction is called a Dataset. OME-NGFF calls
 * pyramid/resolution levels "datasets" — in this module those are always
 * "resolution level" / "pyramid level" / "multiscale level", never "dataset".
 *
 * A Dataset owns source IO and the derived metadata (channels, dimensions,
 * physical space, capabilities) and knows how to translate itself into the
 * viewer's default layer configs. Runtime resources (fetches, parsed
 * geometry) live on the instance and are released via {@link Dataset.dispose};
 * the {@link DatasetConfig} it was created from stays pure JSON.
 */

import type {
  ImagePyramid,
  LayerConfig,
  PhysicalSpace,
  Vec2,
  VolumeRenderMode,
} from "../types";
import { planVolumePreview } from "../utils/tile/volume-policy";

/**
 * Loader identity map: each dataset kind owns its exact declarative config
 * here, keyed by its `type` discriminator. Format packages augment this map
 * via module augmentation (see `galavi/ome-zarr`):
 *
 * ```ts
 * declare module "galavi" {
 *   interface DatasetConfigMap {
 *     "ome-zarr": { type: "ome-zarr"; source: string };
 *   }
 * }
 * ```
 *
 * Augmenting the map extends {@link DatasetConfig} and types
 * `registerDataset` for the new kind — an unknown `type` key or a missing
 * required field is a compile error, not a runtime surprise.
 */
export interface DatasetConfigMap {
  /** Built-in OBJ mesh loader (always registered through the core entry). */
  mesh: { type: "mesh"; source: string };
}

/**
 * Declarative dataset configuration — the union of every registered loader's
 * config. `type` is the public loader identity resolving through
 * `datasetRegistry` (`registerDataset`). Must survive
 * `JSON.parse(JSON.stringify(...))` unchanged — runtime resources never
 * appear here.
 */
export type DatasetConfig = DatasetConfigMap[keyof DatasetConfigMap];

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

/**
 * The presentation contract: which viewer modes this dataset can actually
 * build layers for, and which one `mode: "auto"` resolves to. Format-neutral
 * by design — a dataset advertises real presentations, never image-pyramid
 * facts (pyramid diagnostics like z-depth stay on the format-specific
 * subclass, e.g. `ImageDataset.pyramid`).
 */
export interface DatasetCapabilities {
  /** Modes the dataset can drive; intersected with target layout support by the Viewer. */
  modes       : readonly ("slice" | "volume" | "quad")[];
  /** What viewer `mode: "auto"` resolves to — always a member of `modes`. */
  defaultMode : "slice" | "volume" | "quad";
}

/**
 * Derive image-dataset capabilities from pyramid/chunk metadata, reusing the
 * DX-M4 tile-budget policy semantics: `planVolumePreview` returns `null` for
 * well-behaved pyramids (they render directly — a valid preview) and a
 * bounded plan for pathological ones, so every non-empty 3D pyramid
 * advertises volume. 2D pyramids (z ≤ 1) are slice-only.
 */
export function getDatasetCapabilities(pyramid: ImagePyramid): DatasetCapabilities {
  const zDepth = pyramid.levels[0]?.shape[2] ?? 0;
  if (zDepth <= 1) {
    return { modes: ["slice"], defaultMode: "slice" };
  }
  const plan = planVolumePreview(pyramid);
  // null → well-behaved, volume renders the pyramid directly; plan → bounded.
  if (plan === null || plan.maxTiles > 0) {
    return { modes: ["slice", "volume", "quad"], defaultMode: "volume" };
  }
  return { modes: ["slice"], defaultMode: "slice" };
}

/**
 * Inputs for {@link Dataset.createDefaultLayers} — mirrors what the Viewer
 * facade knows at scene-build time (per-view prefix/kind/axes, the resolved
 * channels, volume projection, and the mode's declared transform).
 */
export interface DefaultLayersOptions {
  /** Kind of view the layers are built for. */
  view         : "volume" | "slice";
  /** Layer id prefix for this view (e.g. `volume`, `quad-xy`). */
  prefix       : string;
  /** In-plane axes for slice planes (quad mode). */
  axes?        : readonly string[];
  /** Resolved channels to build layers for (may be empty). */
  channels     : DatasetChannel[];
  /** Volume accumulation projection (volume views only). */
  projection?  : VolumeRenderMode;
  /** 4×4 column-major affine forwarded to each layer's `data.transform`. */
  transform?   : number[];
}

/**
 * Dataset — one opened data source with normalized metadata. Subclasses are
 * registered by kind via `registerDataset` and constructed + loaded through
 * `openDataset`. Each open constructs and loads a fresh instance; disposal is
 * the caller's job.
 */
export abstract class Dataset {
  /** The dataset kind discriminator (from the config). */
  readonly type: string;
  /** The declarative config this dataset was opened from (pure JSON). */
  readonly config: DatasetConfig;

  /** Display name from source metadata, when present. */
  name?            : string;
  /** Physical space derived from the source (drives the facade's camera fit). */
  physical?        : PhysicalSpace;
  /** Normalized channels — populated by subclasses during `load()`. */
  channels         : DatasetChannel[] = [];
  /** Non-spatial selection dimensions. */
  dimensions       : DatasetDimension[] = [];
  /** Default index per non-spatial dimension. */
  defaultSelection : Record<string, number> = {};
  /**
   * The modes this dataset can build (`modes`) and what `mode: "auto"`
   * resolves to (`defaultMode`). Subclasses populate this during `load()`.
   */
  capabilities     : DatasetCapabilities = { modes: ["slice"], defaultMode: "slice" };

  constructor(config: DatasetConfig) {
    this.type = config.type;
    this.config = config;
  }

  /** Perform source IO and populate the metadata fields above. */
  abstract load(): Promise<void>;

  /** Release runtime resources held by this dataset. */
  abstract dispose(): void;

  /** Build the default layer configs for one of the facade's views. */
  abstract createDefaultLayers(options: DefaultLayersOptions): LayerConfig[];
}
