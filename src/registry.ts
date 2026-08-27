/**
 * Registry<T, F> — pure capability registration + lookup.
 *
 * Holds factories keyed by type string. This module is deliberately free of
 * concrete capability imports (type-only imports of the contract bases
 * below): the singletons start EMPTY and are filled by the idempotent
 * `ensureBuiltIn*()` bootstrap in each owning folder barrel
 * (`src/primitives/layer/index.ts`, `src/primitives/view/index.ts`,
 * `src/primitives/control/index.ts`, `src/primitives/overlay/index.ts`,
 * `src/dataset/index.ts`), invoked at the resolution boundaries
 * (`createViewerRuntime`, `openDataset`). The one documented exception is the
 * `galavi/ome-zarr` subpath, which self-registers on import.
 *
 * There is no `create()` — callers `resolve(type)` and invoke the factory
 * themselves, so instantiation never happens inside the registry.
 */

import type { LayerConfig } from "./state/schema";
import type {
  Dataset,
  DatasetAdapter,
  DatasetConfigMap,
} from "./dataset/contract";
import type { BaseLayer } from "./primitives/layer/base";
import type { BaseControl } from "./primitives/control/base";
import type { BaseOverlay } from "./primitives/overlay/base";
import type { BaseView } from "./primitives/view/base";

// ============================================================================
// ERRORS
// ============================================================================

/**
 * A resolution-boundary miss: a capability reference (dataset kind, layer
 * type, view type, control type, overlay type, …) names no registered
 * implementation. The message names the kind, the type key, the registered
 * alternatives, and — when known — the fix (e.g. the subpath import that
 * provides the capability).
 */
export class CapabilityResolutionError extends Error {
  /** The capability kind, e.g. `"dataset kind"`, `"layer type"`. */
  readonly kind: string;
  /** The unresolved type key. */
  readonly type: string;
  /** The registered type keys at resolution time. */
  readonly available: readonly string[];
  /** Actionable fix, when known (e.g. `Did you mean to import "galavi/ome-zarr"?`). */
  readonly hint?: string;

  constructor(init: {
    kind      : string;
    type      : string;
    available : readonly string[];
    hint?     : string;
  }) {
    super(
      `Unknown ${init.kind}: "${init.type}" (registered: ${init.available.join(", ") || "none"}).` +
      (init.hint ? ` ${init.hint}` : ""),
    );
    this.name = "CapabilityResolutionError";
    this.kind = init.kind;
    this.type = init.type;
    this.available = [...init.available];
    if (init.hint !== undefined) this.hint = init.hint;
  }
}

// ============================================================================
// GENERIC REGISTRY CLASS
// ============================================================================

export class Registry<T, F extends (...args: any[]) => T> {
  private readonly factories = new Map<string, F>();
  /** Capability kind label used in error messages (e.g. `"dataset kind"`). */
  private readonly kind: string;

  constructor(kind: string) {
    this.kind = kind;
  }

  /**
   * Register a factory. A capability key is an identity: re-registering an
   * existing key throws, naming the conflicting key — tests and plugins
   * register unique keys (and unregister them again in teardown). Returns an
   * unregister function for the registration.
   */
  register(type: string, factory: F): () => void {
    if (this.factories.has(type)) {
      throw new Error(
        `Duplicate ${this.kind} registration: "${type}" is already registered. ` +
        "Capability keys are unique — choose a distinct key " +
        "(tests: unregister the key again in teardown).",
      );
    }
    this.factories.set(type, factory);
    return () => { this.unregister(type); };
  }

  /**
   * Resolve the factory for a type; the caller invokes it. A miss throws
   * {@link CapabilityResolutionError} naming the kind, the key, and the
   * registered alternatives.
   */
  resolve(type: string): F {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new CapabilityResolutionError({
        kind      : this.kind,
        type,
        available : this.keys(),
      });
    }
    return factory;
  }

  /** Check if a type is registered */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /** Enumerate registered type keys. */
  keys(): string[] {
    return [...this.factories.keys()];
  }

  /** Remove a registration. Returns true if a key was removed. */
  unregister(type: string): boolean {
    return this.factories.delete(type);
  }
}

// ============================================================================
// CAPABILITY REGISTRIES (start empty — see the module header)
// ============================================================================

export type LayerFactory   = (id: string, desc: LayerConfig) => BaseLayer;
export type ControlFactory = (id: string, options?: Record<string, unknown>) => BaseControl;
export type OverlayFactory = () => BaseOverlay;
export type ViewFactory    = (id: string) => BaseView;

export const layerRegistry   = new Registry<BaseLayer, LayerFactory>("layer type");
export const controlRegistry = new Registry<BaseControl, ControlFactory>("control type");
export const overlayRegistry = new Registry<BaseOverlay, OverlayFactory>("overlay type");
export const viewRegistry    = new Registry<BaseView, ViewFactory>("view type");

/**
 * Dataset kinds register here. A dataset kind key is a loader identity:
 * re-registering an existing key throws (naming the key) instead of silently
 * replacing the loader — tests and plugins register unique keys (and
 * `unregister` afterwards). The built-in `"mesh"` kind is registered by
 * `ensureBuiltInDatasets()` (src/dataset/index.ts); only the
 * `galavi/ome-zarr` subpath registers on import, by design.
 */
export const datasetRegistry = new Registry<Dataset, DatasetAdapter>("dataset kind");

// ============================================================================
// CUSTOM REGISTRATION HELPERS (for advanced 3rd-party developers)
// ============================================================================

/** Register a custom layer type. Returns an unregister function. */
export function registerLayer(type: string, factory: LayerFactory): () => void {
  return layerRegistry.register(type, factory);
}

/** Register a custom control type. Returns an unregister function. */
export function registerControl(type: string, factory: ControlFactory): () => void {
  return controlRegistry.register(type, factory);
}

/** Register a custom overlay type. Returns an unregister function. */
export function registerOverlay(type: string, factory: OverlayFactory): () => void {
  return overlayRegistry.register(type, factory);
}

/** Register a custom view type. Returns an unregister function. */
export function registerView(type: string, factory: ViewFactory): () => void {
  return viewRegistry.register(type, factory);
}

/**
 * Register a dataset kind — the single dataset/source extension point. The
 * kind must be a key of `DatasetConfigMap` (format packages augment that map
 * via `declare module "galavi"`), which types the adapter's config exactly.
 * Re-registering an existing key throws, naming the conflicting key. Returns
 * an unregister function.
 */
export function registerDatasetAdapter<K extends keyof DatasetConfigMap>(
  kind    : K,
  adapter : (config: DatasetConfigMap[K]) => Dataset,
): () => void {
  return datasetRegistry.register(kind, adapter as DatasetAdapter);
}
