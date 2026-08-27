/**
 * Viewer compositions — registration, built-in bootstrap, resolution, and
 * auto-selection for the composition axis. The composition contract (types
 * and shared builders) lives in `../contract` and is re-exported here.
 *
 * A composition translates a Dataset's normalized RESOURCES into a
 * {@link CompositionPlan}: generated `LayerConfig`s (runtime data bound in
 * the plan — the composition IS the binding mechanism), canvas-free view
 * configs, the host layout the Viewer must provide, and the bindings the
 * Viewer uses for live channel/projection/slice-focus updates. Compositions
 * are pure and stateless — lifecycle, Dataset ownership, DOM ownership,
 * controls/tools plumbing, paging, and camera fitting stay in the Viewer; a
 * composition decides whether it SUPPORTS a Dataset (from the primary
 * normalized resource) and how resources become a scene.
 *
 * The composition registry lives here (instantiated from the pure
 * `../../registry` module — registry.ts never imports viewer code). Built-ins
 * (`slice` / `volume` / `quad` / `grid`) register through the same bootstrap
 * (`ensureBuiltInCompositions`, invoked by the Viewer's resolution boundary)
 * as custom compositions registered via {@link registerComposition}; every
 * composition — built-in or custom, direct or registered — traverses the same
 * resolve/build/mount path. `"auto"` is creation-time selection intent
 * ({@link resolveAutoComposition}), never a registered composition and never
 * stored in `State`.
 */

import type { Dataset } from "../../dataset";
import { Registry } from "../../registry";
import {
  primaryResourceOf,
  type ViewerComposition,
} from "../contract";
import { sliceComposition } from "./slice";
import { volumeComposition } from "./volume";
import { quadComposition } from "./quad";
import { gridComposition } from "./grid";

export { sliceComposition } from "./slice";
export { volumeComposition } from "./volume";
export { quadComposition } from "./quad";
export { gridComposition } from "./grid";

// The canonical composition contract (types + shared builders).
export {
  MAIN_VIEW_ID,
  buildImageLayers,
  buildMeshLayer,
  primaryResourceOf,
  supportsVolumePyramid,
  unsupportedPrimary,
} from "../contract";
export type {
  CompositionBindings,
  CompositionBuildInput,
  CompositionInput,
  CompositionPlan,
  CompositionViewConfig,
  HostLayout,
  ViewerComposition,
} from "../contract";

// ============================================================================
// COMPOSITION REGISTRY + BOOTSTRAP
// ============================================================================

/**
 * Composition types register here. A composition type key is an identity:
 * re-registering an existing key throws (naming the key) instead of silently
 * replacing the composition — tests and plugins register unique keys (and
 * `unregister` afterwards).
 */
export const compositionRegistry = new Registry<ViewerComposition, () => ViewerComposition>(
  "composition type",
);

/**
 * Register a composition type — the single composition extension point.
 * `composition.type` must equal `type` (the registry key IS the composition's
 * identity). Re-registering an existing key throws, naming the conflicting
 * key. Returns an unregister function.
 */
export function registerComposition(type: string, composition: ViewerComposition): () => void {
  if (!composition || typeof composition !== "object"
    || typeof composition.supports !== "function" || typeof composition.build !== "function") {
    throw new Error(
      `registerComposition("${type}"): a composition must implement { type, supports, build }`,
    );
  }
  if (composition.type !== type) {
    throw new Error(
      `registerComposition("${type}"): the composition's own type is "${composition.type}" — ` +
      "the registry key and the composition type must agree",
    );
  }
  return compositionRegistry.register(type, () => composition);
}

/**
 * Idempotent built-in bootstrap: registers the built-in compositions in
 * resolution order (`slice`, `volume`, `quad`, `grid`). Invoked at the
 * composition resolution boundary (`createViewer` / `setComposition` /
 * `setState`); double-invocation is a no-op.
 */
export function ensureBuiltInCompositions(): void {
  for (const composition of [sliceComposition, volumeComposition, quadComposition, gridComposition]) {
    if (!compositionRegistry.has(composition.type)) {
      compositionRegistry.register(composition.type, () => composition);
    }
  }
}

/**
 * Resolve a registered composition by type. A miss throws
 * `CapabilityResolutionError` naming the kind, the key, and the registered
 * alternatives.
 */
export function resolveComposition(type: string): ViewerComposition {
  ensureBuiltInCompositions();
  return compositionRegistry.resolve(type)();
}

/** The registered composition types supporting `dataset`, in resolution order. */
export function supportedCompositions(dataset: Dataset): string[] {
  ensureBuiltInCompositions();
  return compositionRegistry.keys()
    .filter((type) => compositionRegistry.resolve(type)().supports(dataset));
}

/**
 * The `"auto"` policy: 3D image → volume, 2D image → slice, mesh-only →
 * volume, otherwise the first supported composition in resolution order.
 * Returns undefined when no registered composition supports the dataset — the
 * Viewer turns that into an actionable error.
 */
export function resolveAutoComposition(dataset: Dataset): string | undefined {
  ensureBuiltInCompositions();
  const supported = (type: string): boolean =>
    compositionRegistry.has(type) && compositionRegistry.resolve(type)().supports(dataset);
  const primary = primaryResourceOf(dataset);
  if (primary?.kind === "mesh") {
    return supported("volume") ? "volume" : undefined;
  }
  if (primary?.kind === "image-pyramid") {
    const zDepth = primary.pyramid.levels[0]?.shape[2] ?? 0;
    if (zDepth > 1) {
      if (supported("volume")) return "volume";
    } else if (supported("slice")) {
      return "slice";
    }
  }
  return supportedCompositions(dataset)[0];
}
