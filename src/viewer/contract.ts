/**
 * Viewer contract — the canonical boundary between the Viewer facade and the
 * compositions it drives (`viewer/compositions/slice.ts`, `volume.ts`,
 * `quad.ts`, `grid.ts`).
 *
 * A composition translates a Dataset's normalized RESOURCES into a
 * {@link CompositionPlan}: generated `LayerConfig`s (with owned layer IDs,
 * projection, axes, and transform choices), canvas-free view configs, the host
 * layout the Viewer must provide, and the bindings the Viewer uses for live
 * channel/projection/slice-focus updates. Compositions are pure and stateless —
 * lifecycle, Dataset ownership, DOM ownership, controls/tools plumbing, paging,
 * and camera fitting stay in the Viewer.
 *
 * Dependency rule: this module imports nothing from `viewer/compositions/` or
 * `viewer/runtime` (the plan's view configs are the structural
 * {@link CompositionViewConfig}, a subset of the runtime's `ViewConfig`), so
 * the compositions barrel, the built-in compositions, the facade, and the
 * runtime can all depend on it without a cycle.
 */

import type {
  Dataset,
  DatasetChannel,
  DatasetResource,
  ImagePyramidResource,
  MeshResource,
} from "../dataset";
import type {
  CompositionReference,
  Data,
  ImagePyramid,
  JsonObject,
  LayerConfig,
  SurfaceGeometry,
  VolumeRenderMode,
} from "../state/schema";
import type { AxisMap } from "../utils";
import { planVolumePreview } from "./tile/volume-policy";

/** The single-view id used by the volume and slice compositions. */
export const MAIN_VIEW_ID = "main";

// ============================================================================
// COMPOSITION CONTRACT
// ============================================================================

/**
 * The host layout a plan requires from the Viewer: one canvas (`single`), the
 * 2×2 quad layout (`quad`), or a paged pool of canvases (`grid` — the Viewer
 * owns the pool DOM and paging; the composition stays pure).
 */
export type HostLayout =
  | { kind: "single" }
  | { kind: "quad" }
  | { kind: "grid"; pool: number };

/**
 * The canvas-free view config a plan declares: the view-registry `type`, the
 * generated layer IDs it renders, and activation/label metadata. A structural
 * subset of the runtime's `ViewConfig` — the Viewer adds the canvas,
 * controls, overlays, and autoRotate when it assembles the runtime config.
 */
export interface CompositionViewConfig {
  /** View type (a view-registry key, e.g. `"slice"` / `"volume"`). */
  type          : string;
  /** Generated layer ids rendered in this view. */
  layers        : string[];
  /** Whether this view can become the active view (default: true). */
  activatable?  : boolean;
  /** Human-readable label for this view. */
  label?        : string;
}

/**
 * The live-update wiring a plan hands the Viewer: the facade never infers
 * layer IDs, it drives these lists.
 */
export interface CompositionBindings {
  /** Channel index → every generated layer presenting that channel. */
  channels         : Map<number, string[]>;
  /** Volume-projection-capable layer ids (the `viewer.projection` targets). */
  projectionLayers : string[];
  /**
   * Focus-driven slice planes: the through-plane axis is `axes[2]` of the
   * RESOLVED axis map; the Viewer pushes the camera target's slice index into
   * every listed layer. Compositions with config-driven slice positions
   * (e.g. `grid` paging) omit their planes here.
   */
  slicePlanes      : { viewId: string; layerIds: string[]; axes: AxisMap }[];
}

/**
 * A built scene: every generated layer plus everything the Viewer needs to
 * host and drive it — without ever inspecting layer IDs.
 */
export interface CompositionPlan {
  /** Every generated layer, in construction order (runtime data bound here). */
  layers       : LayerConfig[];
  /** Canvas-free view configs; view `type` is a view-registry type. */
  views        : Record<string, CompositionViewConfig>;
  /** The view that receives active focus on scene entry. */
  activeViewId : string;
  /** The host layout the Viewer must provide. */
  layout       : HostLayout;
  /** Live-update wiring (channels / projection / slice focus). */
  bindings     : CompositionBindings;
  /** Normalized, portable composition config (JSON-safe) — echoed into `State.composition.config`. */
  config?      : JsonObject;
}

/** What the Viewer hands a composition at scene-build time. */
export interface CompositionBuildInput {
  /** The open Dataset (resources already normalized by `load()`). */
  dataset    : Dataset;
  /** Effective channels (dataset defaults + viewer/per-composition overrides). */
  channels   : DatasetChannel[];
  /** Volume accumulation projection for generated volume layers. */
  projection?: VolumeRenderMode;
  /**
   * Model transform baked into every generated image layer's
   * `data.transform` (the composition's declared 4×4 column-major affine).
   * Mesh layers ignore it, matching the layer config contract for fitted
   * surfaces.
   */
  transform? : number[];
  /** The composition's portable config (from the reference / `setCompositionConfig`). */
  config?    : JsonObject;
}

/**
 * A viewer composition: support check + resource-to-plan translation. `type`
 * is the registry key (and the `State.composition.type` vocabulary).
 */
export interface ViewerComposition {
  /** The composition type (registry key). */
  readonly type: string;
  /** Whether this composition can present `dataset` (primary-resource based). */
  supports(dataset: Dataset): boolean;
  /** Translate the dataset's resources into a scene plan. */
  build(input: CompositionBuildInput): CompositionPlan;
}

/**
 * How a composition is selected (ViewerConfig.composition / setComposition):
 * `"auto"` (creation-time policy), a declarative {@link CompositionReference}
 * resolved through the registry, or a direct implementation bypassing the
 * registry. A direct implementation may carry a portable `reference` — without
 * one, `viewer.getState()` fails explicitly rather than emitting an unportable
 * document.
 */
export type CompositionInput =
  | "auto"
  | CompositionReference
  | { implementation: ViewerComposition; reference?: CompositionReference };

// ============================================================================
// SHARED BUILDERS
// ============================================================================

/**
 * The resource reference compositions translate: the Dataset's primary
 * resource, falling back to the sole resource when no primary is declared.
 * A Dataset with several resources and no valid primary has no normalized
 * primary — reference compositions do not guess.
 */
export function primaryResourceOf(dataset: Dataset): DatasetResource | undefined {
  const primary = dataset.resources.find(
    (resource) => resource.id === dataset.primaryResourceId,
  );
  if (primary !== undefined) return primary;
  if (dataset.primaryResourceId === undefined && dataset.resources.length === 1) {
    return dataset.resources[0];
  }
  return undefined;
}

/**
 * Volume/quad support for an image pyramid, reusing the automatic volume
 * tile-budget policy semantics: 2D pyramids (z ≤ 1) are slice-only; every
 * non-empty 3D pyramid supports volume — `planVolumePreview` returns `null`
 * for well-behaved pyramids (rendered directly) and a bounded plan for
 * pathological ones.
 */
export function supportsVolumePyramid(pyramid: ImagePyramid): boolean {
  const zDepth = pyramid.levels[0]?.shape[2] ?? 0;
  if (zDepth <= 1) return false;
  const plan = planVolumePreview(pyramid);
  // null → well-behaved, volume renders the pyramid directly; plan → bounded.
  return plan === null || plan.maxTiles > 0;
}

/**
 * Translate an image-pyramid resource into one typed layer per channel
 * (additive multichannel compositing, per-channel `selection.c`).
 */
export function buildImageLayers(
  resource : ImagePyramidResource,
  options  : {
    view        : "volume" | "slice";
    prefix      : string;
    axes?       : readonly string[];
    channels    : DatasetChannel[];
    projection? : VolumeRenderMode;
    transform?  : number[];
  },
): LayerConfig[] {
  const { view, prefix, axes, channels, projection, transform } = options;
  return channels.map((channel) => ({
    id   : `${prefix}-c${channel.index}`,
    type : view,
    data : {
      pyramid : resource.pyramid,
      fetch   : resource.fetch,
      ...(transform !== undefined ? { transform: [...transform] } : {}),
    },
    render: {
      visible        : channel.visible,
      color          : channel.color,
      contrastLimits : [...channel.contrast] as [number, number],
      // One layer per channel composites fluorescence-style: additive is
      // the multichannel default for generated image layers.
      blending       : "additive",
      ...(view === "volume" ? { volumeProjection: projection } : {}),
    },
    options: {
      ...(axes ? { axes: [...axes] } : {}),
      selection: { ...resource.defaultSelection, c: channel.index },
    },
  }));
}

/**
 * Translate a mesh resource into the single surface layer: the loaded
 * geometry (when present) is handed over as `Data.geometry` — one fetch and
 * one parse per dataset open, shared by every referencing view; the layer
 * never re-fetches the URL.
 */
export function buildMeshLayer(
  resource : MeshResource,
  options  : { prefix: string },
): LayerConfig {
  const data: Data = { url: resource.source };
  if (resource.geometry) data.geometry = cloneGeometry(resource.geometry);
  return {
    id      : `${options.prefix}-mesh`,
    type    : "surface",
    data,
    options : { fitToUnitAABB: true },
  };
}

/** Defensive copy for the layer handoff — surface normalization mutates positions. */
function cloneGeometry(geometry: SurfaceGeometry): SurfaceGeometry {
  return {
    ...geometry,
    positions : geometry.positions.slice(),
    normals   : geometry.normals?.slice(),
    uvs       : geometry.uvs?.slice(),
    indices   : geometry.indices?.slice(),
  };
}

/** The error for `build()` called on a dataset the composition does not support. */
export function unsupportedPrimary(composition: string, dataset: Dataset): Error {
  const primary = primaryResourceOf(dataset);
  return new Error(
    `composition "${composition}" cannot build a scene for dataset kind "${dataset.type}" ` +
    `(primary resource: ${primary ? `"${primary.kind}" "${primary.id}"` : "none"}) — ` +
    "check the composition's supports() result first",
  );
}
