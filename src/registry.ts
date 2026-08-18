/**
 * Registry<T, F> — Generic factory registry
 *
 * Holds built-in + custom factories keyed by type string. `F` is the factory
 * signature so `create()` is type-safe via `Parameters<F>`.
 */

import type { LayerConfig } from "./types";
import type { Dataset, DatasetConfig, DatasetConfigMap } from "./dataset/base";
import { MeshDataset } from "./dataset/mesh";
import {
  BaseLayer,
  VolumeLayer,
  SliceLayer,
  SurfaceLayer,
  ShapesLayer,
  PointsLayer,
  SegmentationLayer,
  VectorsLayer,
  TracksLayer,
  NetworkLayer,
  type LayerClass,
} from "./layer";
import {
  BaseControl,
  FlyControl,
  OrbitControl,
  PanZoomControl,
  type ControlClass,
} from "./control";
import {
  BaseOverlay,
  CrosshairOverlay,
  RulerOverlay,
  RoiSelectorOverlay,
  MagnifierOverlay,
  FoldablePanelOverlay,
  type OverlayClass,
} from "./overlay";
import {
  BaseView,
  VolumeView,
  SliceView,
  NavigatorView,
  type ViewClass,
} from "./view";

// ============================================================================
// GENERIC REGISTRY CLASS
// ============================================================================

export class Registry<T, F extends (...args: any[]) => T> {
  private factories?: Map<string, F>;
  private readonly buildBuiltins: () => Record<string, F>;
  private readonly duplicateError?: (type: string) => Error;

  /**
   * Built-ins are lazy. The thunk runs on first access so concrete classes
   * (which import from this module's siblings) finish initializing first —
   * registry.ts sits at the top of the import cycle.
   *
   * `duplicateError`, when set, makes `register` reject an already-registered
   * key instead of silently overriding it (used by the dataset registry,
   * where a duplicate key means two loaders are fighting over one identity).
   */
  constructor(
    buildBuiltins: () => Record<string, F>,
    duplicateError?: (type: string) => Error,
  ) {
    this.buildBuiltins = buildBuiltins;
    this.duplicateError = duplicateError;
  }

  private getFactories(): Map<string, F> {
    if (!this.factories) {
      this.factories = new Map(Object.entries(this.buildBuiltins()));
    }
    return this.factories;
  }

  /**
   * Register a custom factory. Overrides an existing key unless the registry
   * was constructed with a `duplicateError` (then a duplicate throws).
   */
  register(type: string, factory: F): void {
    const factories = this.getFactories();
    if (this.duplicateError && factories.has(type)) throw this.duplicateError(type);
    factories.set(type, factory);
  }

  /** Create an instance. Throws if type is unknown. */
  create(type: string, ...args: Parameters<F>): T {
    const factory = this.getFactories().get(type);
    if (!factory) throw new Error(`Unknown type: "${type}"`);
    return factory(...args);
  }

  /** Check if a type is registered */
  has(type: string): boolean {
    return this.getFactories().has(type);
  }

  /** Enumerate registered type keys (built-ins + custom). */
  keys(): string[] {
    return [...this.getFactories().keys()];
  }

  /** Remove a registration. Returns true if a key was removed. */
  unregister(type: string): boolean {
    return this.getFactories().delete(type);
  }
}

// ============================================================================
// BUILT-IN REGISTRIES
// ============================================================================

/**
 * Build a `{ type: factory }` map from a list of self-registering classes.
 * `builder(cls)` decides how to turn a class into a factory — either a static
 * method binding (e.g. `cls.fromConfig.bind(cls)`) or a constructor wrapper
 * (`(...a) => new cls(...a)`).
 */
function fromClasses<F extends (...args: any[]) => unknown>(
  classes : readonly Record<string, any>[],
  typeKey : string,
  builder : (cls: any) => F,
): Record<string, F> {
  const out: Record<string, F> = {};
  for (const cls of classes) out[cls[typeKey] as string] = builder(cls);
  return out;
}

type LayerFactory   = (id: string, desc: LayerConfig) => BaseLayer;
type ControlFactory = (id: string, options?: Record<string, unknown>) => BaseControl;
type OverlayFactory = () => BaseOverlay;
type ViewFactory    = (id: string) => BaseView;

// NOTE: getters (not top-level `const` arrays) so the class identifiers are
// resolved lazily, after every sibling module has finished initializing.
// `view/runtime/factory.ts` imports from this module, so eager evaluation here
// hits a TDZ on `VolumeView` etc. when the cycle closes.
const getLayerClasses   = (): readonly LayerClass[]   => [
  VolumeLayer, SliceLayer, SurfaceLayer, ShapesLayer, PointsLayer,
  SegmentationLayer, VectorsLayer, TracksLayer, NetworkLayer,
];
const getControlClasses = (): readonly ControlClass[] => [
  OrbitControl, FlyControl, PanZoomControl,
];
const getOverlayClasses = (): readonly OverlayClass[] => [
  CrosshairOverlay, RulerOverlay, RoiSelectorOverlay, FoldablePanelOverlay,
];
const getViewClasses    = (): readonly ViewClass[]    => [
  VolumeView, SliceView, NavigatorView,
];

export const layerRegistry   = new Registry<BaseLayer, LayerFactory>(() =>
  fromClasses<LayerFactory>(getLayerClasses(), "layerType", (cls) => cls.fromConfig.bind(cls)),
);
export const controlRegistry = new Registry<BaseControl, ControlFactory>(() =>
  fromClasses<ControlFactory>(getControlClasses(), "controlType", (cls) => cls.create.bind(cls)),
);
export const overlayRegistry = new Registry<BaseOverlay, OverlayFactory>(() => ({
  ...fromClasses<OverlayFactory>(getOverlayClasses(), "overlayType", (cls) => () => new cls()),
  // Separate tool entries over one implementation parameterized by dimension.
  "magnifier-2d" : () => new MagnifierOverlay("2d"),
  "magnifier-3d" : () => new MagnifierOverlay("3d"),
}));
export const viewRegistry    = new Registry<BaseView, ViewFactory>(() =>
  fromClasses<ViewFactory>(getViewClasses(), "viewType", (cls) => (id) => new cls(id)),
);

/** DatasetFactory — constructs a Dataset from its declarative config. */
export type DatasetFactory = (config: DatasetConfig) => Dataset;

/**
 * Dataset kinds register here. The built-in `"mesh"` loader is a LAZY
 * built-in (resolved on first registry access, like every other registry
 * above) so the core entry stays free of module-load side effects — only the
 * `galavi/ome-zarr` subpath registers on import, by design (API-6). Kind
 * modules otherwise never get imported by this module.
 *
 * A dataset kind key is a loader identity: re-registering an existing key
 * throws (naming the key) instead of silently replacing the loader — tests
 * and plugins register unique keys (and `unregister` afterwards).
 */
export const datasetRegistry = new Registry<Dataset, DatasetFactory>(
  // The thunk runs on first access, so the MeshDataset binding resolves
  // after every sibling module has finished initializing.
  () => ({
    mesh: (config) => new MeshDataset(config),
  }),
  (kind) => new Error(
    `Duplicate dataset kind registration: "${kind}" is already registered. ` +
    "Dataset loader keys are unique — choose a distinct key " +
    "(tests: unregister the key again in teardown).",
  ),
);

// ============================================================================
// CUSTOM REGISTRATION HELPERS (for advanced 3rd-party developers)
// ============================================================================

/** Register a custom layer type */
export function registerLayer(type: string, factory: LayerFactory): void {
  layerRegistry.register(type, factory);
}

/** Register a custom control type */
export function registerControl(type: string, factory: ControlFactory): void {
  controlRegistry.register(type, factory);
}

/** Register a custom overlay type */
export function registerOverlay(type: string, factory: OverlayFactory): void {
  overlayRegistry.register(type, factory);
}

/** Register a custom view type */
export function registerView(type: string, factory: ViewFactory): void {
  viewRegistry.register(type, factory);
}

/**
 * Register a dataset kind — the single dataset/source extension point. The
 * kind must be a key of `DatasetConfigMap` (format packages augment that map
 * via `declare module "galavi"`), which types the factory's config exactly.
 * Re-registering an existing key throws, naming the conflicting key.
 */
export function registerDataset<K extends keyof DatasetConfigMap>(
  kind    : K,
  factory : (config: DatasetConfigMap[K]) => Dataset,
): void {
  datasetRegistry.register(kind, factory as DatasetFactory);
}
