/**
 * Registry<T, F> — Generic factory registry
 *
 * Holds built-in + custom factories keyed by type string. `F` is the factory
 * signature so `create()` is type-safe via `Parameters<F>`.
 */

import type {
  Data,
  ImagePyramid,
  LayerConfig,
  PhysicalSpace,
  SourceDescriptor,
} from "./types";
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

  /**
   * Built-ins are lazy. The thunk runs on first access so concrete classes
   * (which import from this module's siblings) finish initializing first —
   * registry.ts sits at the top of the import cycle.
   */
  constructor(buildBuiltins: () => Record<string, F>) {
    this.buildBuiltins = buildBuiltins;
  }

  private getFactories(): Map<string, F> {
    if (!this.factories) {
      this.factories = new Map(Object.entries(this.buildBuiltins()));
    }
    return this.factories;
  }

  /** Register a custom factory (overrides built-ins of the same key) */
  register(type: string, factory: F): void {
    this.getFactories().set(type, factory);
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

/**
 * ResolvedSource — runtime artifacts produced by resolving a
 * {@link SourceDescriptor}. Consumed by tiled image layers: `pyramid` and
 * `fetch` plug into the same pipeline as their explicit `Data` counterparts.
 * All fields are optional so factories can return partial results (e.g. a
 * `physical` hint only), though a tiled layer needs at least `pyramid` to
 * render.
 */
export interface ResolvedSource {
  pyramid?  : ImagePyramid;
  fetch?    : NonNullable<Data["fetch"]>;   // matches Data["fetch"]
  selection?: Record<string, number>;
  physical? : PhysicalSpace;                // optional hint for apps (e.g. adapter-derived)
}

/** SourceFactory — resolves a declarative descriptor into runtime artifacts. */
export type SourceFactory = (desc: SourceDescriptor) => Promise<ResolvedSource>;

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
  CrosshairOverlay, RulerOverlay, RoiSelectorOverlay, MagnifierOverlay, FoldablePanelOverlay,
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
export const overlayRegistry = new Registry<BaseOverlay, OverlayFactory>(() =>
  fromClasses<OverlayFactory>(getOverlayClasses(), "overlayType", (cls) => () => new cls()),
);
export const viewRegistry    = new Registry<BaseView, ViewFactory>(() =>
  fromClasses<ViewFactory>(getViewClasses(), "viewType", (cls) => (id) => new cls(id)),
);
export const sourceRegistry  = new Registry<Promise<ResolvedSource>, SourceFactory>(() => ({}));

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
 * Register a source type — the factory that turns a declarative
 * {@link SourceDescriptor} (`Data.source`) into runtime artifacts.
 * Tiled image layers resolve descriptors asynchronously through this
 * registry; the resolved values never enter `State`.
 */
export function registerSource(type: string, factory: SourceFactory): void {
  sourceRegistry.register(type, factory);
}
