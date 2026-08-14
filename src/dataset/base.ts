/**
 * Dataset base — the abstract contract every dataset kind implements.
 *
 * Terminology: the galavi abstraction is called a Dataset. OME-NGFF calls
 * pyramid/resolution levels "datasets" — in this module those are always
 * "resolution level" / "pyramid level" / "multiscale level", never "dataset".
 *
 * A Dataset owns source IO and the derived metadata (channels, dimensions,
 * physical space, capabilities) and knows how to translate itself into the
 * viewer's default mode and layer configs. Runtime resources (fetches, parsed
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
 * Declarative dataset configuration. `type` is the public discriminator
 * resolving through `datasetRegistry` (`registerDataset`). Must survive
 * `JSON.parse(JSON.stringify(...))` unchanged — runtime resources never
 * appear here.
 */
export interface DatasetConfig {
  /** Dataset kind key, resolved via `datasetRegistry`. */
  type    : string;
  /** Optional source URL or path. */
  source? : string;
  [key: string]: unknown;
}

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
 * What the dataset can drive, derived from pyramid/chunk metadata alone.
 * Lets `mode: "auto"` ask "can volume produce a valid bounded preview"
 * without opening a renderer.
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

/** What viewer mode `"auto"` resolves to, plus the default dimension selection. */
export interface DatasetDefaults {
  mode      : "slice" | "volume" | "quad";
  selection : Record<string, number>;
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
  capabilities     : DatasetCapabilities = {
    zDepth: 0, supports3D: false, supportsVolumePreview: false,
  };

  constructor(config: DatasetConfig) {
    this.type = config.type;
    this.config = config;
  }

  /** Perform source IO and populate the metadata fields above. */
  abstract load(): Promise<void>;

  /** Release runtime resources held by this dataset. */
  abstract dispose(): void;

  /** What `"auto"` resolves to for this dataset. */
  abstract deriveDefaults(): DatasetDefaults;

  /** Build the default layer configs for one of the facade's views. */
  abstract createDefaultLayers(options: DefaultLayersOptions): LayerConfig[];
}
