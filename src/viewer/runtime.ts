/**
 * Viewer runtime — the low-level scene orchestrator.
 *
 * `ViewerRuntime` is the state authority: it holds the global State, manages
 * the global GPU device and views, and owns the runtime layer map:
 * one `BaseLayer` instance per state-layer ID, shared by every referencing
 * view, with one tracked async load and one render-request channel per layer.
 * `createViewerRuntime` is the transactional async factory; `createView` is
 * the per-view wiring factory (registries injected by the runtime — this
 * module never resolves against ambient singleton state without ensuring
 * the built-ins first). Composed directly by advanced integrations and the
 * facade (`src/viewer/index.ts`); the 3D magnifier loupe receives the factory
 * by injection (`bindNestedViewerRuntime`) so the overlay module never
 * imports this one.
 *
 * The runtime configuration types (`ViewerRuntimeConfig`, `ViewConfig`,
 * `ControlOptions`, `OverlayOptions`) live here beside the runtime they
 * configure.
 */

import { vec3 } from "wgpu-matrix";
import type {
  Camera,
  Data,
  Exploration,
  ID,
  LayerConfig,
  PhysicalSpace,
  Render,
  State,
  Vec3,
  ViewResolution,
} from "../state/schema";
import {
  AUTO_ROTATE_SPEED_DEG_PER_SEC,
  DEFAULT_STATE,
} from "../defaults";
import {
  normalizeInitialState,
  normalizePhysicalSpace,
  normalizeState,
} from "../state";
import { resolveTheme, type DeepPartial, type GalaviTheme } from "../primitives/overlay/theme";
import type { OverlayOptionsMap } from "../primitives/overlay/options";
import { ensureBuiltInLayers, type BaseLayer, type LayerLoadState } from "../primitives/layer";
import { ensureBuiltInViews, type BaseView, type ViewOwner } from "../primitives/view";
import {
  ensureBuiltInControls,
  type BaseControl,
  type FlyControlOptions,
  type OrbitControlOptions,
  type PanZoomControlOptions,
} from "../primitives/control";
import { ensureBuiltInOverlays, type BaseOverlay } from "../primitives/overlay";
import { bindNestedViewerRuntime } from "../primitives/overlay/magnifier";
import {
  cameraAngles,
  cameraDistance,
  computeForward,
  computePosition,
} from "../utils";
import {
  controlRegistry,
  layerRegistry,
  overlayRegistry,
  viewRegistry,
  type ControlFactory,
  type OverlayFactory,
  type Registry,
  type ViewFactory,
} from "../registry";

// ============================================================================
// VIEWER RUNTIME CONFIG
// ============================================================================

/**
 * ViewerRuntime configuration — everything needed to create a ViewerRuntime instance.
 *
 * Combines state (the WHAT) and view configurations (the HOW).
 * `await createViewerRuntime(config)` inits GPU, mounts views, returns ready instance.
 */
export interface ViewerRuntimeConfig {
  /** State — physical space, layers, exploration */
  state : State;
  /** View configurations keyed by view name */
  views : Record<string, ViewConfig>;
  /** Overlay UI theme override, merged over the default theme */
  theme?: DeepPartial<GalaviTheme>;
}

/**
 * Control option bags keyed by control type. The built-in control types
 * (orbit / fly / panzoom) carry their typed options; custom control types
 * registered via `registerControl` accept any options bag.
 */
export type ControlOptions = {
  [type: string]: Record<string, unknown> | undefined;
} & {
  orbit?   : OrbitControlOptions;
  fly?     : FlyControlOptions;
  panzoom? : PanZoomControlOptions;
};

/**
 * Overlay option bags keyed by overlay type. The built-in overlay types
 * (see {@link OverlayOptionsMap}) carry their typed options; custom overlay
 * types registered via `registerOverlay` accept any options bag.
 */
export type OverlayOptions = {
  [type: string]: Record<string, unknown> | undefined;
} & {
  [K in keyof OverlayOptionsMap]?: OverlayOptionsMap[K];
};

/**
 * View configuration — defines a single view within a ViewerRuntime instance.
 * Views are keyed by name in `ViewerRuntimeConfig.views`; the key is the view ID.
 */
export interface ViewConfig {
  /** View type */
  type          : string;
  /** Canvas element to render into. Omit for delayed mounting via runtime.mount(). */
  canvas?       : HTMLCanvasElement;
  /**
   * Layers (IDs) to render in this view (must match IDs in state.layers).
   * Each ID resolves to the single runtime layer instance owned by the
   * ViewerRuntime — views referencing the same ID share that instance
   *; per-view GPU resources stay per view/layer pair.
   */
  layers        : ID[];
  /** Controls to attach, keyed by control type (e.g. { orbit: {}, fly: {} }) */
  controls?     : ControlOptions;
  /** Overlays to attach, keyed by overlay type (e.g. { crosshair: {}, ruler: { visible: false } }) */
  overlays?     : OverlayOptions;
  /** Human-readable label for this view */
  label?        : string;
  /** Whether this view can become the active view (default: true) */
  activatable?  : boolean;
  /**
   * Auto-rotate the unified camera (volume views). `true` spins at the default
   * speed; `{ speedDegPerSec }` overrides it. Stops permanently on the first
   * user input (mouse down / key down).
   */
  autoRotate?   : boolean | { speedDegPerSec?: number };
  /**
   * Automatically track canvas content-box resizes with a ResizeObserver and
   * re-render (default: true). The view owns the observer for the lifetime of
   * its canvas binding; set to `false` only when the host drives canvas pixel
   * sizing itself and wants no observer.
   */
  autoResize?   : boolean;
}

// ============================================================================
// LAYER PATCHES
// ============================================================================

type LayerAccessor<TOptions = Record<string, unknown>> = {
  readonly config: LayerConfig<TOptions>;
  setRender(partial: Partial<Render>): void;
  setOptions(partial: Partial<TOptions>): void;
  setData(partial: Partial<Data>): void;
};

/**
 * One layer update inside an {@link ViewerRuntime.updateLayers} transaction
 *. `render` and `data` merge shallowly over the current config;
 * `options` merges per key with the accessor's nested-object semantics (a
 * plain-object value, e.g. `selection`, merges into the existing plain-object
 * value; anything else replaces).
 */
export interface LayerPatch {
  /** Target layer ID — must exist; an unknown ID fails the whole batch. */
  id       : ID;
  options? : Record<string, unknown>;
  render?  : Partial<Render>;
  data?    : Partial<Data>;
}

/**
 * The layer `options` merge semantics shared by `updateLayers` and
 * `layer(id).setOptions`: each key merges into the existing value when both
 * are plain (non-array) objects — `selection: { c: 1 }` preserves sibling
 * selection keys — and replaces otherwise.
 */
function mergeLayerOptions(target: LayerConfig, partial: Record<string, unknown>): void {
  if (!target.options) target.options = {};
  const options = target.options as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    const existing = options[key];
    if (
      existing && typeof existing === "object" && !Array.isArray(existing) &&
      value    && typeof value    === "object" && !Array.isArray(value)
    ) {
      options[key] = {
        ...(existing as Record<string, unknown>),
        ...(value    as Record<string, unknown>),
      };
    } else {
      options[key] = value;
    }
  }
}

/** Apply one patch to a (cloned) layer config: render/data shallow, options nested. */
function applyLayerPatch(target: LayerConfig, patch: LayerPatch): void {
  if (patch.render !== undefined) {
    target.render = { ...(target.render ?? {}), ...patch.render };
  }
  if (patch.options !== undefined) {
    mergeLayerOptions(target, patch.options);
  }
  if (patch.data !== undefined) {
    target.data = { ...(target.data ?? {}), ...patch.data } as Data;
  }
}

type ViewAccessor = {
  /**
   * Update a view overlay's options at runtime. Built-in overlay types
   * (`OverlayOptionsMap` keys) get their exact options bag — a misspelled key
   * is a compile error; custom overlay types registered via `registerOverlay`
   * keep the `Record<string, unknown>` escape hatch.
   */
  setOverlayOptions<K extends string>(
    overlayType : K,
    opts        : K extends keyof OverlayOptionsMap
      ? Partial<OverlayOptionsMap[K]>
      : Record<string, unknown>,
  ): void;
  /**
   * The runtime layer instance for `id` in this view (the single
   * runtime-owned instance — every view referencing the same layer ID returns
   * the same object), or undefined when the view does not reference it.
   */
  getLayer(id: ID): BaseLayer | undefined;
  /**
   * Resolve once the layer reports `isReady` (see `BaseView.whenLayerReady`
   * for the full semantics). Rejects when the layer ID is unknown in this
   * view, when the layer's source fails to load (with the recorded
   * load error), when `opts.signal` aborts, or when the layer/view goes away.
   */
  whenLayerReady(layerId: ID, opts?: { signal?: AbortSignal }): Promise<BaseLayer>;
  /**
   * Snapshot of a layer's load state: `idle` / `loading` / `ready` /
   * `error`, with the recorded error when failed (see
   * `BaseView.getLayerStatus`). Returns undefined when the layer ID is
   * unknown in this view.
   */
  getLayerStatus(layerId: ID): LayerLoadState | undefined;
  getCurrentLevel(layerId: ID): number | undefined;
  getResolution(layerId: ID): ViewResolution | undefined;
  readonly config: ViewConfig;
  readonly base: BaseView;
};

// ============================================================================
// VIEW FACTORY (registries injected by the runtime)
// ============================================================================

/**
 * The primitive registries {@link createView} resolves through — injected by
 * the runtime so this factory never imports the registry singletons directly.
 */
export interface ViewRegistries {
  views    : Registry<BaseView, ViewFactory>;
  controls : Registry<BaseControl, ControlFactory>;
  overlays : Registry<BaseOverlay, OverlayFactory>;
}

export interface ViewRuntime {
  config      : ViewConfig;
  view        : BaseView;
  layers      : Map<string, BaseLayer>;
  overlays    : Map<string, BaseOverlay>;
  activatable : boolean;
  label?      : string;
}

/**
 * Create and wire a fully initialized view from a ViewConfig.
 *
 * Runtime layer instances are NOT created here: the ViewerRuntime owns one
 * `BaseLayer` per state-layer ID and this factory hands each view
 * references from that shared map (`runtimeLayers`, built from
 * `state.layers`); the returned ViewRuntime's `layers` maps the view's
 * configured IDs to those shared instances. Views referencing the same layer
 * ID share the instance; per-view GPU resources stay per view/layer pair.
 */
export function createView(
  name          : string,
  config        : ViewConfig,
  runtimeLayers : ReadonlyMap<ID, BaseLayer>,
  owner         : ViewOwner,
  registries    : ViewRegistries,
): ViewRuntime {
  const view = registries.views.resolve(config.type)(name as ID);
  view.setOwner(owner);
  view.autoResize = config.autoResize ?? true;

  // Resolve the view's layer references against the runtime-owned runtime map.
  const layers = new Map<string, BaseLayer>();
  for (const layerName of config.layers) {
    const layer = runtimeLayers.get(layerName);
    if (!layer) {
      throw new Error(
        `[createView] View "${name}" references layer "${layerName}" which is not in state.layers`,
      );
    }
    layers.set(layerName, layer);
  }

  // Register control(s)
  const localControls: BaseControl[] = [];
  for (const [ctrlType, ctrlOptions] of Object.entries(config.controls ?? {})) {
    // Registry boundary is untyped: built-in control factories re-parse their
    // own options (see `opt*` readers), so a plain options bag suffices here.
    localControls.push(registries.controls.resolve(ctrlType)(
      `${name}-${ctrlType}`,
      ctrlOptions as Record<string, unknown> | undefined,
    ));
  }
  if (localControls.length > 0) {
    view.setControls(localControls);
  }

  // Attach overlays
  const overlayMap = new Map<string, BaseOverlay>();
  for (const [overlayType, overlayOpts] of Object.entries(config.overlays ?? {})) {
    const overlay = registries.overlays.resolve(overlayType)();
    // Registry boundary is untyped: built-in overlays re-parse their own
    // options in `setOptions`, so a plain options bag suffices here.
    overlay.setOptions?.(overlayOpts as Record<string, unknown> | undefined);
    view.addOverlay(overlay);
    overlayMap.set(overlayType, overlay);
  }

  // Wire layers → view
  for (const entry of layers.values()) {
    view.addLayer(entry);
  }

  return {
    config,
    view,
    layers,
    overlays    : overlayMap,
    activatable : config.activatable ?? true,
    label       : config.label,
  };
}

/** The runtime's own registry handles, injected into every `createView` call. */
const RUNTIME_REGISTRIES: ViewRegistries = {
  views    : viewRegistry,
  controls : controlRegistry,
  overlays : overlayRegistry,
};

// ============================================================================
// VIEWER RUNTIME (low-level orchestrator)
// ============================================================================

export class ViewerRuntime implements ViewOwner {
  /** Resolved overlay UI theme (`ViewerRuntimeConfig.theme` over the FUI defaults). */
  readonly theme: GalaviTheme;

  private _exploration  : Exploration;
  private _layers       : LayerConfig[];
  private _physical?    : PhysicalSpace;

  private readonly _subscribers = new Set<(state: State) => void>();

  /**
   * The runtime layer map: one `BaseLayer` instance per state-layer
   * ID, built once at construction from `State.layers` and shared by every
   * referencing view. Views receive references from this map — a surface OBJ
   * referenced by four views is fetched/parsed once. Per-view GPU resources
   * (pipelines, tile pools) remain per view/layer pair.
   */
  private readonly _runtimeLayers = new Map<ID, BaseLayer>();

  private _views              = new Map<string, ViewRuntime>();
  private _device?             : GPUDevice;
  private _activeViewId?       : string;
  private _pendingRenderState? : State;
  private _renderFrameId?      : number;

  private _autoRotateActive   = false;
  private _autoRotateSpeedDeg = AUTO_ROTATE_SPEED_DEG_PER_SEC;
  private _autoRotateFrameId? : number;
  private _autoRotateLastTs   = 0;

  // ====================================================================
  // CONSTRUCTOR
  // ====================================================================

  constructor(config: ViewerRuntimeConfig) {
    // Resolution boundary: the built-in capabilities register here,
    // idempotently (this constructor resolves layer/view/control/overlay
    // types against the registries below).
    ensureBuiltInLayers();
    ensureBuiltInViews();
    ensureBuiltInControls();
    ensureBuiltInOverlays();

    this.theme = resolveTheme(config.theme);

    // Initialize State
    const initial = normalizeInitialState(config.state ?? DEFAULT_STATE);
    this._physical    = initial.physical;
    this._layers      = initial.layers;
    this._exploration = initial.exploration;

    // Build the shared runtime layers and attach each one's render-request
    // channel exactly once (the fan-out reads `_views` at signal time).
    for (const desc of this._layers) {
      if (this._runtimeLayers.has(desc.id)) continue; // first config wins
      const layer = layerRegistry.resolve(desc.type)(desc.id, desc);
      layer.attach({ requestRender: () => this._onLayerSignal(layer) });
      this._runtimeLayers.set(desc.id, layer);
    }

    // Create Views
    for (const [name, vc] of Object.entries(config.views)) {
      this._views.set(name, createView(name, vc, this._runtimeLayers, this, RUNTIME_REGISTRIES));
    }

    // Auto-rotate: enabled by the first volume view that opts in.
    for (const vc of Object.values(config.views)) {
      if (vc.type !== "volume" || !vc.autoRotate) continue;
      this._autoRotateActive = true;
      if (typeof vc.autoRotate === "object" && typeof vc.autoRotate.speedDegPerSec === "number") {
        this._autoRotateSpeedDeg = vc.autoRotate.speedDegPerSec;
      }
      break;
    }
  }

  // ====================================================================
  // GPU & RENDER
  // ====================================================================

  async initGPU(): Promise<void> {
    if (this._device) return;

    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU not supported");
    this._device = await adapter.requestDevice();

    for (const vr of this._views.values()) {
      vr.view.setDevice(this._device);
    }

    // One tracked async load per runtime layer, started once the GPU
    // device exists (`initAsync`'s documented precondition). Each load's
    // settle fans out to every referencing view; a failure is recorded on the
    // layer (`loadStatus`/`loadError`) — handled here, never unhandled.
    for (const layer of this._runtimeLayers.values()) {
      layer.ensureLoaded().then(
        () => this._onLayerLoadSettled(layer),
        () => this._onLayerLoadSettled(layer),
      );
    }
  }

  /**
   * Layer render-request fan-out: the layer's single runtime-owned
   * channel lands here — settle every referencing view's readiness waiters
   * and schedule one frame.
   */
  private _onLayerSignal(layer: BaseLayer): void {
    for (const vr of this._views.values()) {
      if (vr.layers.get(layer.id) === layer) vr.view.notifyLayerSignal(layer);
    }
    this.requestRender();
  }

  /**
   * Tracked-load settle fan-out: additionally rebuild each
   * referencing view's per-layer GPU pipelines so freshly loaded data
   * becomes drawable.
   */
  private _onLayerLoadSettled(layer: BaseLayer): void {
    for (const vr of this._views.values()) {
      if (vr.layers.get(layer.id) === layer) vr.view.handleLayerLoadSettled(layer);
    }
    this.requestRender();
  }

  private render(state: State): void {
    for (const vr of this._views.values()) {
      try {
        vr.view.render(state);
      } catch (e) {
        // Don't crash sibling views on a single bad view; surface as error.
        console.error(`[ViewerRuntime] view "${vr.view.id}" render failed:`, e);
      }
    }
  }

  private scheduleRender(state: State): void {
    this._pendingRenderState = state;
    if (this._renderFrameId !== undefined) return;

    this._renderFrameId = requestAnimationFrame(() => {
      this._renderFrameId = undefined;
      const nextState = this._pendingRenderState;
      this._pendingRenderState = undefined;
      if (nextState) this.render(nextState);
    });
  }

  // ====================================================================
  // STATE
  // ====================================================================

  /** Get the full state snapshot (mutable clone — safe for controls to mutate). */
  getState(): State {
    return {
      physical    : normalizePhysicalSpace(this._physical),
      layers      : this._layers.map(l => ({
        ...l,
        render  : l.render  ? { ...l.render }  : undefined,
        options : l.options ? { ...l.options } : undefined,
        data    : l.data    ? { ...l.data }    : undefined,
      })),
      exploration : {
        ...this._exploration,
        camera: {
          ...this._exploration.camera,
          position : [...this._exploration.camera.position] as Vec3,
          target   : [...this._exploration.camera.target] as Vec3,
          ...(this._exploration.camera.up ? { up: [...this._exploration.camera.up] as Vec3 } : {}),
        },
        ...(this._exploration.temporal ? { temporal: { ...this._exploration.temporal } } : {}),
      },
    };
  }

  /** Replace the full state. Normalizes, notifies subscribers, schedules render. */
  setState(next: State): void {
    this._commit(next);
  }

  /**
   * Schedule a render of the current state without going through commit/notify.
   *
   * Use for render-only triggers (e.g. tile uploads, animation ticks, async
   * geometry loads) where state did not logically change. Avoids the deep clone
   * + subscriber fan-out of a full `setState(getState())` round trip.
   */
  requestRender(): void {
    this.scheduleRender(this._sharedSnapshot());
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(callback: (state: State) => void): () => void {
    this._subscribers.add(callback);
    return () => { this._subscribers.delete(callback); };
  }

  // ====================================================================
  // CONVENIENCE ACCESSORS
  // ====================================================================

  /** Current camera state (read-only by convention). */
  get camera(): Camera {
    return this._exploration.camera;
  }

  /** Cloned copy of the current camera target position. */
  get target(): Vec3 {
    return [...this._exploration.camera.target] as Vec3;
  }

  /** Get a layer handle by ID, or undefined if not found. */
  layer<TOptions = Record<string, unknown>>(id: ID): LayerAccessor<TOptions> | undefined {
    if (!this._layers.some(l => l.id === id)) return undefined;
    const self = this;

    // Each setter is a one-patch `updateLayers` transaction: the
    // single-update and batch-update paths share one patch/merge logic, and
    // there is one and only one mutation site (`_commit`).
    return {
      get config(): LayerConfig<TOptions> {
        const entry = self._layers.find(l => l.id === id)!;
        return {
          ...entry,
          render  : entry.render  ? { ...entry.render }  : undefined,
          options : entry.options ? { ...entry.options } : undefined,
          data    : entry.data    ? { ...entry.data }    : undefined,
        } as LayerConfig<TOptions>;
      },
      setRender(partial: Partial<Render>): void {
        self.updateLayers([{ id, render: partial }]);
      },
      setOptions(partial: Partial<TOptions>): void {
        self.updateLayers([{ id, options: partial as Record<string, unknown> }]);
      },
      setData(partial: Partial<Data>): void {
        self.updateLayers([{ id, data: partial }]);
      },
    };
  }

  /**
   * Apply several layer patches as ONE atomic transaction: every ID
   * is validated before any mutation — an unknown ID throws, naming it, and
   * leaves State completely unchanged. State is cloned once, all patches
   * apply in order, and the result commits once: one subscriber notification,
   * one scheduled render. An empty patch list is a no-op (no commit, no
   * notify, no render). Use this for related multi-layer updates;
   * `layer(id).set*` remains the single-update path, implemented through here.
   */
  updateLayers(patches: LayerPatch[]): void {
    if (patches.length === 0) return;
    const known = new Set(this._layers.map((l) => l.id));
    for (const patch of patches) {
      if (!known.has(patch.id)) {
        throw new Error(`ViewerRuntime.updateLayers: unknown layer id "${patch.id}"`);
      }
    }
    const next = this.getState();
    // The runtime's own snapshot always carries its layer list (State.layers is
    // optional only on portable facade documents).
    const layers = next.layers ?? [];
    for (const patch of patches) {
      const target = layers.find((l) => l.id === patch.id)!;
      applyLayerPatch(target, patch);
    }
    this._commit(next);
  }

  /** Set the camera target position (mode-aware: orbit recomputes position). */
  setTarget(target: Vec3): void {
    const state = this.getState();
    const cam = state.exploration.camera;
    cam.target = [...target] as Vec3;
    if (cam.navMode === "orbit") {
      const dist = cameraDistance(cam);
      const { yaw, pitch } = cameraAngles(cam);
      cam.position = computePosition(cam.target, dist, yaw, pitch);
    }
    this._commit(state);
  }

  /** Switch navigation mode (orbit ↔ fly) with camera recomputation. */
  setNavMode(mode: "orbit" | "fly"): void {
    const state = this.getState();
    const cam = state.exploration.camera;
    if (cam.navMode === mode) return;
    if (mode === "orbit") {
      const { yaw, pitch } = cameraAngles(cam);
      const dist = cameraDistance(cam);
      const forward = computeForward(yaw, pitch);
      cam.target = vec3.add(cam.position, vec3.scale(forward, dist)) as Vec3;
    }
    cam.navMode = mode;
    this._commit(state);
  }

  private _commit(next: State): void {
    // Normalize
    const norm = normalizeState(next);

    // Apply
    this._exploration = norm.exploration;
    this._layers      = norm.layers;
    this._physical    = norm.physical;

    // Notify subscribers with a fresh mutable clone so they cannot accidentally
    // poison internal state. Render path uses a shared snapshot — read-only.
    if (this._subscribers.size > 0) {
      const snapshot = this.getState();
      for (const cb of this._subscribers) cb(snapshot);
    }
    this.scheduleRender(this._sharedSnapshot());
  }

  /** Internal: shared (non-cloned) state view for read-only render path. */
  private _sharedSnapshot(): State {
    return {
      physical    : this._physical,
      layers      : this._layers,
      exploration : this._exploration,
    };
  }

  // ====================================================================
  // VIEWS
  // ====================================================================

  /** Get a view by ID. */
  view(viewId: ID): ViewAccessor {
    const vr = this._views.get(viewId);
    if (!vr) throw new Error(`View "${viewId}" not found`);
    return {
      setOverlayOptions: (overlayType: string, opts: Record<string, unknown>) => {
        vr.overlays.get(overlayType)?.setOptions?.(opts);
        this.requestRender();
      },      getLayer: (id: ID) => vr.layers.get(id),
      whenLayerReady: (layerId: ID, opts?: { signal?: AbortSignal }) => {
        const layer = vr.layers.get(layerId);
        if (!layer) {
          return Promise.reject(
            new Error(`Layer "${layerId}" not found in view "${viewId}"`),
          );
        }
        return vr.view.whenLayerReady(layer, opts?.signal);
      },
      getLayerStatus: (layerId: ID) => vr.view.getLayerStatus(layerId),
      getCurrentLevel: (layerId: ID) => vr.view.getCurrentLevel(layerId),
      getResolution: (layerId: ID) => vr.view.getResolution(layerId),
      get config() {
        return vr.config;
      },
      get base() {
        return vr.view;
      },
    };
  }

  getViewConfig(viewId: ID): ViewConfig | undefined {
    return this._views.get(viewId)?.config;
  }

  setActiveView(viewId: ID): void {
    const vr = this._views.get(viewId);
    if (!vr) throw new Error(`View "${viewId}" not found`);
    if (!vr.activatable) return;

    if (this._activeViewId) {
      const prev = this._views.get(this._activeViewId);
      if (prev) {
        prev.view.disableEvents();
        prev.view.isActive = false;
      }
    }

    this._activeViewId = viewId;
    vr.view.enableEvents();
    vr.view.isActive = true;
  }

  getActiveView(): ID | undefined {
    return this._activeViewId;
  }

  async mount(viewId: ID, canvas: HTMLCanvasElement): Promise<void> {
    const vr = this._views.get(viewId);
    if (!vr) throw new Error(`View "${viewId}" not found`);

    if (!this._device) await this.initGPU();
    await vr.view.mount(canvas);
    this.requestRender();
    if (this._autoRotateActive) this.startAutoRotate();
  }

  async mountAll(canvases: Record<ID, HTMLCanvasElement>): Promise<void> {
    if (!this._device) await this.initGPU();
    for (const [id, canvas] of Object.entries(canvases)) {
      const vr = this._views.get(id);
      if (!vr) throw new Error(`View "${id}" not found`);
      await vr.view.mount(canvas);
    }
    this.scheduleRender(this.getState());
    if (this._autoRotateActive) this.startAutoRotate();
  }

  unmount(viewId: ID): void {
    const vr = this._views.get(viewId);
    if (!vr) throw new Error(`View "${viewId}" not found`);
    vr.view.unmount();
  }

  // ====================================================================
  // AUTO-ROTATE
  // ====================================================================

  /**
   * Idle camera spin for volume views (`ViewConfig.autoRotate`). Advances the
   * camera yaw through the normal commit path, so subscribers and overlays
   * observe the same state flow as an interactive orbit drag (same update
   * rate). Stops permanently on the first user input via `stopAutoRotate()`.
   */
  private startAutoRotate(): void {
    if (this._autoRotateFrameId !== undefined) return;
    this._autoRotateLastTs = performance.now();

    const tick = (ts: number) => {
      if (!this._autoRotateActive) {
        this._autoRotateFrameId = undefined;
        return;
      }
      const dt = Math.min((ts - this._autoRotateLastTs) / 1000, 0.1);
      this._autoRotateLastTs = ts;

      const state = this.getState();
      const cam   = state.exploration.camera;
      const dist  = cameraDistance(cam);
      const { yaw, pitch } = cameraAngles(cam);
      cam.position = computePosition(
        cam.target,
        dist,
        yaw + (this._autoRotateSpeedDeg * Math.PI / 180) * dt,
        pitch,
      );
      this._commit(state);

      this._autoRotateFrameId = requestAnimationFrame(tick);
    };

    this._autoRotateFrameId = requestAnimationFrame(tick);
  }

  /** Stop auto-rotate permanently. Called by views on first user input. */
  stopAutoRotate(): void {
    this._autoRotateActive = false;
    if (this._autoRotateFrameId !== undefined) {
      cancelAnimationFrame(this._autoRotateFrameId);
      this._autoRotateFrameId = undefined;
    }
  }

  // ====================================================================
  // CLEANUP
  // ====================================================================

  destroy(): void {
    this.stopAutoRotate();
    if (this._renderFrameId !== undefined) {
      cancelAnimationFrame(this._renderFrameId);
      this._renderFrameId = undefined;
    }
    this._pendingRenderState = undefined;
    for (const vr of this._views.values()) {
      vr.view.destroy();
    }
    // Detach the runtime-owned render channels so late-settling loads go quiet.
    for (const layer of this._runtimeLayers.values()) {
      layer.detach();
    }
    // Release the GPU device itself — destroyed ViewerRuntime instances must not
    // keep counting against the browser's per-page WebGPU device limit.
    this._device?.destroy();
    this._device = undefined;
  }
}

// ============================================================================
// RUNTIME FACTORY
// ============================================================================

/** Throw `signal.reason` (an `AbortError` DOMException by default) when aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason as unknown;
}

/**
 * Settle with `operation`, but reject with `signal.reason` as soon as the
 * signal aborts. `operation` itself is not cancelled — the caller decides how
 * to drain it (createViewerRuntime awaits its settlement before teardown).
 */
function racedAgainstAbort(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason as unknown);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      ()    => { signal.removeEventListener("abort", onAbort); resolve(); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

/**
 * Await structural readiness of every unique layer referenced by `views`
 * : each layer ID is awaited once, through the FIRST view that
 * references it — views share one runtime layer instance per ID, so
 * duplicates across views settle together and are skipped. Resolves when
 * every layer reports `isReady`; rejects with the first layer's recorded
 * load error, or with `signal.reason` on abort.
 */
export function awaitConfiguredLayersReady(
  runtime  : ViewerRuntime,
  views   : Record<string, ViewConfig>,
  signal? : AbortSignal,
): Promise<unknown> {
  const seen = new Set<ID>();
  const pending: Promise<unknown>[] = [];
  for (const [viewId, viewConfig] of Object.entries(views)) {
    let view: ViewAccessor | undefined;
    for (const layerId of viewConfig.layers ?? []) {
      if (seen.has(layerId)) continue;
      seen.add(layerId);
      view ??= runtime.view(viewId);
      pending.push(view.whenLayerReady(layerId, { signal }));
    }
  }
  return Promise.all(pending);
}

/**
 * Options for {@link createViewerRuntime}.
 */
export interface CreateViewerRuntimeOptions {
  /**
   * Cancellation for the creation itself. When the signal aborts — before GPU
   * initialization, while views mount, or during the `"layers"` wait — the
   * returned promise rejects with `signal.reason` (an `AbortError`
   * DOMException by default, matching `view(id).whenLayerReady`) and the
   * partially created runtime is destroyed before the rejection propagates:
   * mounted views unmounted, runtime layers detached, the GPU device
   * released. No render or subscription activity happens after teardown.
   * Aborting after the promise resolved has no effect — the runtime is the
   * caller's by then.
   */
  signal?: AbortSignal;
  /**
   * The readiness bar for the returned promise (default `"mounted"`):
   *
   * - `"mounted"` — resolve once the GPU is initialized and every configured
   *   canvas is mounted (the historical behavior). Layer loads may still be
   *   in flight; observe them per layer via `view(id).whenLayerReady`.
   * - `"layers"` — additionally await STRUCTURAL readiness of every unique
   *   configured layer across all views: each layer's source/pyramid is
   *   available (the same definition the high-level `Viewer` applies before
   *   reporting `ready`). This is NOT first presented pixels — tiled layers
   *   keep refining resolution afterward. A layer whose source fails rejects
   *   with its recorded load error; the runtime is destroyed on rejection.
   *
   * Layer loads are GPU-gated, so `"layers"` initializes the GPU even when
   * no view carries a canvas.
   */
  waitUntil?: "mounted" | "layers";
}

/**
 * Create a ViewerRuntime instance from a ViewerRuntimeConfig.
 * Initialises GPU and mounts views that have a canvas specified.
 *
 * Creation is transactional: when the returned promise rejects (GPU init or
 * mount failure, a failed layer under `waitUntil: "layers"`, or abort), the
 * runtime is destroyed before the rejection propagates — a rejecting factory
 * never hands out the instance, so it must not leave owned resources behind.
 * The original error is rethrown unchanged; cleanup never masks it.
 */
export async function createViewerRuntime(
  config  : ViewerRuntimeConfig,
  options : CreateViewerRuntimeOptions = {},
): Promise<ViewerRuntime> {
  // Resolution boundary: register the built-in capabilities before any
  // registry resolution (idempotent; the constructor is the resolution site
  // and repeats this for direct `new ViewerRuntime(...)` callers).
  ensureBuiltInLayers();
  ensureBuiltInViews();
  ensureBuiltInControls();
  ensureBuiltInOverlays();

  const { signal, waitUntil = "mounted" } = options;
  throwIfAborted(signal);
  const runtime = new ViewerRuntime(config);

  const canvasMap: Record<string, HTMLCanvasElement> = {};
  for (const [name, vc] of Object.entries(config.views)) {
    if (vc.canvas) canvasMap[name] = vc.canvas;
  }

  let mount: Promise<void> | undefined;
  try {
    if (Object.keys(canvasMap).length > 0) {
      mount = runtime.mountAll(canvasMap);
      if (signal) await racedAgainstAbort(mount, signal);
      else await mount;
    } else if (waitUntil === "layers") {
      // Layer loads start with GPU init; with no canvases nothing mounts, so
      // the "layers" bar initializes the GPU explicitly.
      await runtime.initGPU();
    }
    throwIfAborted(signal);
    if (waitUntil === "layers") {
      await awaitConfiguredLayersReady(runtime, config.views, signal);
    }
  } catch (err) {
    // An abort can win the race while the mount is still in flight: drain it
    // first (its own error never replaces the abort reason) so destroy() runs
    // exactly once over a fully settled runtime — a GPU device assigned
    // mid-flight is released here, never leaked.
    if (mount) await mount.catch(() => {});
    runtime.destroy();
    throw err;
  }

  return runtime;
}

// Inject the nested-loupe factory into the magnifier overlay: a direct
// magnifier → runtime import would close a module cycle through the overlay
// barrel, so the runtime hands the factory down instead.
bindNestedViewerRuntime(createViewerRuntime);
