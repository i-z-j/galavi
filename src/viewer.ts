/**
 * Viewer — the public viewing API in one module.
 *
 * Two layers live here:
 *
 * - `ViewerEngine` + `createViewerEngine` — the low-level orchestrator and
 *   state authority. Holds the global State, manages global GPU, Render and
 *   Views, and owns the runtime layer map (ARCH-1): one `BaseLayer` instance
 *   per state-layer ID, shared by every referencing view, with one tracked
 *   async load and one render-request channel per layer. Composed directly
 *   by advanced integrations (and internally by the facade and the 3D
 *   magnifier loupe).
 * - `Viewer` + `createViewer` — the high-level facade (DX-L1/L2/M3/M6): one
 *   dataset session with modes, channels, camera, controls, and tools,
 *   translated onto the engine's scene model (engineering-cleanup-plan.md
 *   §15). `viewer.engine` is the explicit escape hatch for advanced
 *   composition.
 *
 * Async discipline (DX-M2/DX-L2): `open()` and mode transitions are
 * last-write-wins. Every operation carries a revision token; a superseded
 * operation never clobbers newer state and rejects with
 * {@link ViewerSupersededError}. `viewer.ready` settles with the latest
 * operation; `viewer.status` tracks idle/loading/ready/error.
 */

import { vec3 } from "wgpu-matrix";
import type {
  Camera,
  ControlOptions,
  Data,
  Exploration,
  ID,
  LayerConfig,
  OverlayOptions,
  PhysicalSpace,
  Render,
  State,
  Vec3,
  ViewConfig,
  ViewResolution,
  ViewerEngineConfig,
  VolumeRenderMode,
} from "./types";
import {
  AUTO_ROTATE_SPEED_DEG_PER_SEC,
  DEFAULT_CAMERA_NAV_MODE,
  DEFAULT_CAMERA_PROJ_MODE,
  DEFAULT_EXPLORATION,
  DEFAULT_STATE,
} from "./defaults";
import { BaseView } from "./view";
import { createView, type ViewRuntime } from "./view/runtime";
import type { BaseLayer, LayerLoadState } from "./layer";
import { resolveTheme, type DeepPartial, type GalaviTheme } from "./overlay/theme";
import type {
  CrosshairOverlayOptions,
  MagnifierOverlayOptions,
  OverlayOptionsMap,
  RoiSelectorOverlayOptions,
  RulerOverlayOptions,
} from "./overlay/options";
import { Dataset, openDataset, type DatasetConfig } from "./dataset";
import { controlRegistry, layerRegistry, overlayRegistry } from "./registry";
import type {
  BaseControl,
  FlyControlOptions,
  OrbitControlOptions,
  PanZoomControlOptions,
} from "./control";
import type { BaseOverlay, RoiBox, RoiSelectionChange } from "./overlay";
import {
  cameraAngles,
  cameraDistance,
  clampContrastLimits,
  computeForward,
  computePosition,
  fitSliceCamera,
  frameVolumeCamera,
  normalizeHexColor,
  resolveAxes,
} from "./utils";

// ============================================================================
// VIEWER ENGINE (low-level orchestrator)
// ============================================================================

type LayerAccessor<TOptions = Record<string, unknown>> = {
  readonly config: LayerConfig<TOptions>;
  setRender(partial: Partial<Render>): void;
  setOptions(partial: Partial<TOptions>): void;
  setData(partial: Partial<Data>): void;
};

/**
 * One layer update inside an {@link ViewerEngine.updateLayers} transaction
 * (ARCH-2). `render` and `data` merge shallowly over the current config;
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
   * The runtime layer instance for `id` in this view (ARCH-1: the single
   * engine-owned instance — every view referencing the same layer ID returns
   * the same object), or undefined when the view does not reference it.
   */
  getLayer(id: ID): BaseLayer | undefined;
  /**
   * Resolve once the layer reports `isReady` (see `BaseView.whenLayerReady`
   * for the full semantics). Rejects when the layer ID is unknown in this
   * view, when the layer's source fails to load (DX-M2 — with the recorded
   * load error), when `opts.signal` aborts, or when the layer/view goes away.
   */
  whenLayerReady(layerId: ID, opts?: { signal?: AbortSignal }): Promise<BaseLayer>;
  /**
   * Snapshot of a layer's load state (DX-M2): `idle` / `loading` / `ready` /
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

export class ViewerEngine {
  /** Resolved overlay UI theme (`ViewerEngineConfig.theme` over the FUI defaults). */
  readonly theme: GalaviTheme;

  private _exploration  : Exploration;
  private _layers       : LayerConfig[];
  private _physical?    : PhysicalSpace;

  private readonly _subscribers = new Set<(state: State) => void>();

  /**
   * The runtime layer map (ARCH-1): one `BaseLayer` instance per state-layer
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

  constructor(config: ViewerEngineConfig) {
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
      const layer = layerRegistry.create(desc.type, desc.id, desc);
      layer.attach({ requestRender: () => this._onLayerSignal(layer) });
      this._runtimeLayers.set(desc.id, layer);
    }

    // Create Views
    for (const [name, vc] of Object.entries(config.views)) {
      this._views.set(name, createView(name, vc, this._runtimeLayers, this));
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

    // ARCH-1: one tracked async load per runtime layer, started once the GPU
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
   * Layer render-request fan-out (ARCH-1): the layer's single engine-owned
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
   * Tracked-load settle fan-out (ARCH-1): additionally rebuild each
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
        console.error(`[ViewerEngine] view "${vr.view.id}" render failed:`, e);
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

    // Each setter is a one-patch `updateLayers` transaction (ARCH-2): the
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
   * Apply several layer patches as ONE atomic transaction (ARCH-2): every ID
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
        throw new Error(`ViewerEngine.updateLayers: unknown layer id "${patch.id}"`);
      }
    }
    const next = this.getState();
    for (const patch of patches) {
      const target = next.layers.find((l) => l.id === patch.id)!;
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
    // Detach the engine-owned render channels so late-settling loads go quiet.
    for (const layer of this._runtimeLayers.values()) {
      layer.detach();
    }
    // Release the GPU device itself — destroyed ViewerEngine instances must not
    // keep counting against the browser's per-page WebGPU device limit.
    this._device?.destroy();
    this._device = undefined;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a ViewerEngine instance from a ViewerEngineConfig.
 * Initialises GPU and mounts views that have a canvas specified.
 */
export async function createViewerEngine(config: ViewerEngineConfig): Promise<ViewerEngine> {
  const engine = new ViewerEngine(config);

  const canvasMap: Record<string, HTMLCanvasElement> = {};
  for (const [name, vc] of Object.entries(config.views)) {
    if (vc.canvas) canvasMap[name] = vc.canvas;
  }

  if (Object.keys(canvasMap).length > 0) {
    await engine.mountAll(canvasMap);
  }

  return engine;
}

// ============================================================================
// UTILITIES
// ============================================================================

function normalizeExploration(exploration: Exploration): Exploration {
  const cam = exploration.camera;
  return {
    camera: {
      navMode   : cam.navMode ?? DEFAULT_CAMERA_NAV_MODE,
      projMode  : cam.projMode ?? DEFAULT_CAMERA_PROJ_MODE,
      position  : [...cam.position] as Vec3,
      target    : [...cam.target] as Vec3,
      up        : cam.up ? ([...cam.up] as Vec3) : undefined,
    },
    temporal: exploration.temporal ? { ...exploration.temporal } : undefined,
  };
}

function normalizeLayers(layers: LayerConfig[]): LayerConfig[] {
  return layers.map((l) => {
    const render = l.render ? { ...l.render } : {};
    if (render.visible === undefined) render.visible = true;
    return { ...l, render };
  });
}

function normalizePhysicalSpace(physical?: PhysicalSpace): PhysicalSpace | undefined {
  if (!physical) return undefined;
  return {
    ...physical,
    spatial: {
      ...physical.spatial,
      size      : [...physical.spatial.size] as Vec3,
      spacing   : physical.spatial.spacing ? [...physical.spatial.spacing] as Vec3 : undefined,
      origin    : physical.spatial.origin ? [...physical.spatial.origin] as Vec3 : undefined,
      transform : physical.spatial.transform ? [...physical.spatial.transform] : undefined,
    },
  };
}

/** Normalize full state — camera constraints, layer defaults, deep-copy physical. */
export function normalizeState(state: State): State {
  return {
    exploration : normalizeExploration(state.exploration),
    layers      : normalizeLayers(state.layers),
    physical    : normalizePhysicalSpace(state.physical),
  };
}

export function normalizeInitialState(state: State): State {
  return normalizeState({
    ...DEFAULT_STATE,
    ...state,
    exploration: {
      ...DEFAULT_EXPLORATION,
      ...state.exploration,
      camera: {
        ...DEFAULT_EXPLORATION.camera,
        ...state.exploration.camera,
      },
    },
  });
}

// ============================================================================
// VIEWER CONFIG
// ============================================================================

/**
 * Visualization mode. `"auto"` resolves per dataset via
 * `Dataset.capabilities.defaultMode` (e.g. 3D image datasets default to
 * volume, 2D to slice); the modes a dataset can actually build are exposed
 * through `viewer.availableModes`, and assigning an unavailable mode throws.
 */
export type ViewerMode = "auto" | "slice" | "volume" | "quad";

/** A concrete (non-auto) mode. */
export type ResolvedViewerMode = Exclude<ViewerMode, "auto">;

/** Volume ray-march accumulation — maps to low-level `render.volumeProjection` (DX-Q5). */
export type ViewerProjection = VolumeRenderMode;

/** Viewer load/transition status (DX-M2). */
export type ViewerStatus = "idle" | "loading" | "ready" | "error";

/** One channel's declarative config — the `viewer.channel(index)` counterpart (DX-M3). */
export interface ViewerChannelConfig {
  /** Channel index — the `c` selection value of the underlying layers. */
  index     : number;
  /** Display label (defaults to the dataset's normalized label). */
  label?    : string;
  /** Visibility (defaults to metadata `active` flags, else first channel only). */
  visible?  : boolean;
  /** Display color, `#RRGGBB` (a missing `#` is added; malformed values throw). */
  color?    : string;
  /** Contrast window, clamped to normalized [0, 1] with low ≤ high. */
  contrast? : [number, number];
}

/** Initial/updated camera: `"fit"` frames the dataset bounds; a partial merges over it. */
export type ViewerCamera = "fit" | Partial<Camera>;

/**
 * Declarative control set (DX-M6). `true` enables with defaults, an options
 * bag enables with those options, `false`/absent disables. When `controls` is
 * present it fully specifies the control set for the current mode's views;
 * when absent, the mode default applies (orbit for volume, panzoom for
 * slice; quad gets panzoom on the plane views and orbit on the 3D view).
 */
export interface ViewerControlsConfig {
  orbit?   : boolean | OrbitControlOptions;
  fly?     : boolean | FlyControlOptions;
  panzoom? : boolean | PanZoomControlOptions;
}

/** Magnifier tool options: the overlay options plus an optional dimension pin. */
export type ViewerMagnifierOptions = MagnifierOverlayOptions & {
  /** Loupe dimension; defaults to `"3d"` on volume views, `"2d"` on slice views. */
  dimension?: "2d" | "3d";
};

/**
 * High-level ROI tool options (API-4): the JSON-serializable subset of the
 * low-level {@link RoiSelectorOverlayOptions}. The `onRoisChange` /
 * `onActiveIndexChange` callbacks are excluded by type, and passing them
 * anyway throws at runtime (never silently dropped). ROI changes reach the
 * application through the typed Viewer events — `viewer.on("roiChange" |
 * "roiActiveChange", handler)`; callback-bearing overlay options remain
 * available on the low-level engine path
 * (`view.setOverlayOptions("roiselector", ...)`, galavi/advanced).
 */
export type ViewerRoiOptions = Omit<
  RoiSelectorOverlayOptions,
  "onRoisChange" | "onActiveIndexChange"
>;

/**
 * Declarative tool set (DX-M6). Tools map to built-in overlays: crosshair →
 * `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier →
 * `"magnifier-2d"`/`"magnifier-3d"`. `true` enables with defaults, an options
 * bag enables with those options, `false`/absent disables. When `tools` is
 * present it fully specifies the tool set. Options bags are JSON-serializable
 * intent (API-4): functions throw at validation.
 */
export interface ViewerToolsConfig {
  crosshair? : boolean | CrosshairOverlayOptions;
  ruler?     : boolean | RulerOverlayOptions;
  magnifier? : false | "2d" | "3d" | ViewerMagnifierOptions;
  roi?       : boolean | ViewerRoiOptions;
}

/**
 * Per-mode overrides applied when ENTERING that mode (scientifically
 * justified per-mode contrast/tools). Imperative equivalent:
 * `viewer.view(mode).configure(value)`. Overrides layer over the base config:
 * channels merge per index, camera/controls/tools replace the base value for
 * that mode's entries when present.
 */
export interface ViewerModeOverride {
  channels? : ViewerChannelConfig[];
  camera?   : ViewerCamera;
  controls? : ViewerControlsConfig;
  tools?    : ViewerToolsConfig;
  /**
   * Model transform for every layer CONSTRUCTED for this mode — a 4×4
   * column-major affine forwarded to each layer's `data.transform`. Because
   * it is layer config (not runtime mutation), it survives the Viewer's
   * open/mode-transition rebuilds by construction. Like the low-level
   * `data.transform`, it replaces the default physical-space scale/translate
   * (see `applyTransformConfig`), so the affine must encode the full
   * voxel→world mapping. Absent → the physical-space default.
   */
  transform? : number[];
}

export type ViewerModeOverrides = Partial<Record<ResolvedViewerMode, ViewerModeOverride>>;

/**
 * The minimal high-level viewer schema (§15.2). JSON-serializable by
 * contract: no callbacks, no runtime resources.
 */
export interface ViewerConfig {
  /** Dataset config; opened via `openDataset` (dataset registry). */
  dataset?       : DatasetConfig;
  /** Visualization mode (default `"auto"`). */
  mode?          : ViewerMode;
  /** Channel overrides over the dataset's normalized channels. */
  channels?      : ViewerChannelConfig[];
  /** Volume accumulation projection (default `"mip"`). */
  projection?    : ViewerProjection;
  /** Initial camera (default `"fit"` via the dataset bounds helpers). */
  camera?        : ViewerCamera;
  controls?      : ViewerControlsConfig;
  tools?         : ViewerToolsConfig;
  modeOverrides? : ViewerModeOverrides;
  /**
   * Overlay UI theme, merged over the engine's default theme and forwarded to
   * the underlying `createViewerEngine` call. Plain string bag — stays JSON-serializable.
   */
  theme?         : DeepPartial<GalaviTheme>;
  /**
   * Idle camera spin for volume views — forwarded to the generated volume
   * `ViewConfig.autoRotate`. Absent/false disables (the low-level default).
   */
  autoRotate?    : boolean | { speedDegPerSec?: number };
}

// ============================================================================
// IMPERATIVE ACCESSORS
// ============================================================================

/** Channel patch accepted by `viewer.channel(index).configure` (DX-M3). */
export type ViewerChannelPatch = Partial<Omit<ViewerChannelConfig, "index">>;

/** Fully-resolved channel state (dataset defaults + overrides). */
export interface ViewerChannelState {
  index    : number;
  label    : string;
  visible  : boolean;
  color    : string;
  contrast : [number, number];
}

/** `viewer.control(name)` handle (DX-M6). */
export interface ViewerControlAccessor<TOptions> {
  /** Whether the control is currently part of the active control set. */
  readonly enabled : boolean;
  /** Merge typed options and enable; same bag as the declarative key. */
  configure(options : Partial<TOptions>) : void;
  /** Enable (default options when never configured) or disable. */
  enable(enabled? : boolean) : void;
}

/** `viewer.tool(name)` handle (DX-M6). */
export interface ViewerToolAccessor<TOptions> {
  /** Whether the tool's overlay is currently attached and visible. */
  readonly enabled : boolean;
  /** Merge typed options and enable; same bag as the declarative key. */
  configure(options : Partial<TOptions>) : void;
  /** Enable (default options when never configured) or disable. */
  enable(enabled? : boolean) : void;
}

/** `viewer.channel(index)` handle (DX-M3). */
export interface ViewerChannelAccessor {
  /** Current effective channel state (dataset defaults + overrides). */
  readonly config : ViewerChannelState;
  /** Merge a channel patch; same validation/default merge as `channels[n]`. */
  configure(patch : ViewerChannelPatch) : void;
}

/** `viewer.view(mode)` handle — the imperative `modeOverrides[mode]` equivalent. */
export interface ViewerViewAccessor {
  /** Merge per-mode overrides; applies immediately when that mode is active. */
  configure(value : ViewerModeOverride) : void;
}

/** Typed control names and their option bags. */
export interface ViewerControlOptionsMap {
  orbit   : OrbitControlOptions;
  fly     : FlyControlOptions;
  panzoom : PanZoomControlOptions;
}
export type ViewerControlName = keyof ViewerControlOptionsMap;

/** Typed tool names and their option bags (JSON-serializable — API-4). */
export interface ViewerToolOptionsMap {
  crosshair : CrosshairOverlayOptions;
  ruler     : RulerOverlayOptions;
  magnifier : ViewerMagnifierOptions;
  roi       : ViewerRoiOptions;
}
export type ViewerToolName = keyof ViewerToolOptionsMap;

// ============================================================================
// VIEWER EVENTS (API-4)
// ============================================================================

/**
 * Payload of the high-level `"roiChange"` Viewer event: the full ROI list
 * after the change, what changed, and where it happened (the interacting view
 * plus the mode in effect — quad mode attaches one ROI overlay per view).
 */
export interface ViewerRoiChangeEvent {
  /** Full ROI list after the change (physical coordinates). */
  rois   : RoiBox[];
  /** Which ROI changed, how, and whether this is a live drag or the commit. */
  change : RoiSelectionChange;
  /** The view the interaction happened in (e.g. `"main"`, `"quad-xy"`). */
  viewId : string;
  /** The resolved mode in effect when the change happened. */
  mode   : ResolvedViewerMode;
}

/** Payload of the high-level `"roiActiveChange"` Viewer event. */
export interface ViewerRoiActiveChangeEvent {
  /** The newly active ROI index, or null when none is active. */
  activeIndex : number | null;
  /** The view the interaction happened in (e.g. `"main"`, `"quad-xy"`). */
  viewId      : string;
  /** The resolved mode in effect when the change happened. */
  mode        : ResolvedViewerMode;
}

/**
 * The typed high-level Viewer runtime events (API-4). Runtime notifications
 * live here — never in {@link ViewerConfig}, which stays JSON-serializable.
 * `viewer.on(name, handler)` returns an unsubscribe function; subscriptions
 * survive open/mode rebuilds and are cleared on `destroy()`.
 */
export interface ViewerEventMap {
  roiChange       : ViewerRoiChangeEvent;
  roiActiveChange : ViewerRoiActiveChangeEvent;
}
export type ViewerEventName = keyof ViewerEventMap;

// ============================================================================
// ERRORS + VALIDATION
// ============================================================================

/** Rejection reason for an `open()`/mode transition superseded by a newer call. */
export class ViewerSupersededError extends Error {
  constructor(operation: string) {
    super(`${operation} superseded by a newer call — the latest call wins`);
    this.name = "ViewerSupersededError";
  }
}

const VIEWER_MODES: readonly ViewerMode[] = ["auto", "slice", "volume", "quad"];
const RESOLVED_MODES: readonly ResolvedViewerMode[] = ["slice", "volume", "quad"];
const PROJECTIONS: readonly ViewerProjection[] = ["mip", "minip", "mean"];
const CONTROL_NAMES: readonly ViewerControlName[] = ["orbit", "fly", "panzoom"];
const TOOL_NAMES: readonly ViewerToolName[] = ["crosshair", "ruler", "magnifier", "roi"];

function assertViewerMode(value: unknown): asserts value is ViewerMode {
  if (!VIEWER_MODES.includes(value as ViewerMode)) {
    throw new Error(`Invalid viewer mode: ${JSON.stringify(value)} (expected one of: ${VIEWER_MODES.join(", ")})`);
  }
}

function assertResolvedMode(value: unknown): asserts value is ResolvedViewerMode {
  if (!RESOLVED_MODES.includes(value as ResolvedViewerMode)) {
    throw new Error(`Invalid mode: ${JSON.stringify(value)} (expected one of: ${RESOLVED_MODES.join(", ")} — "auto" is not a mode entry)`);
  }
}

function assertProjection(value: unknown): asserts value is ViewerProjection {
  if (!PROJECTIONS.includes(value as ViewerProjection)) {
    throw new Error(`Invalid projection: ${JSON.stringify(value)} (expected one of: ${PROJECTIONS.join(", ")})`);
  }
}

function assertControlName(value: unknown): asserts value is ViewerControlName {
  if (!CONTROL_NAMES.includes(value as ViewerControlName)) {
    throw new Error(`Unknown control: ${JSON.stringify(value)} (expected one of: ${CONTROL_NAMES.join(", ")})`);
  }
}

function assertToolName(value: unknown): asserts value is ViewerToolName {
  if (!TOOL_NAMES.includes(value as ViewerToolName)) {
    throw new Error(`Unknown tool: ${JSON.stringify(value)} (expected one of: ${TOOL_NAMES.join(", ")})`);
  }
}

const EVENT_NAMES: readonly ViewerEventName[] = ["roiChange", "roiActiveChange"];

function assertEventName(value: unknown): asserts value is ViewerEventName {
  if (!EVENT_NAMES.includes(value as ViewerEventName)) {
    throw new Error(`Unknown viewer event: ${JSON.stringify(value)} (expected one of: ${EVENT_NAMES.join(", ")})`);
  }
}

/**
 * Reject functions in a high-level tool options bag (API-4): the Viewer
 * config surface is JSON-serializable intent, so a function value means the
 * caller wants a runtime callback — fail loudly with the supported path
 * instead of letting the `viewer.config` JSON mirror silently drop it.
 */
function assertSerializableToolOptions(
  name    : ViewerToolName,
  options : Record<string, unknown>,
  context : string,
): void {
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== "function") continue;
    throw new Error(
      `${context}: tools.${name}.${key} is a function — high-level tool options are JSON-serializable only. ` +
      (name === "roi"
        ? 'Subscribe via viewer.on("roiChange" | "roiActiveChange", handler) for ROI notifications, ' +
          'or use the low-level engine path: view.setOverlayOptions("roiselector", { onRoisChange }).'
        : "Callback-bearing overlay options live on the low-level engine path: view.setOverlayOptions(...)."),
    );
  }
}

// ============================================================================
// NORMALIZATION (shared by the declarative and imperative paths — §15.4)
// ============================================================================

/**
 * Validate and normalize one channel patch. Used identically for config
 * `channels[n]`, `modeOverrides` channel entries, and
 * `viewer.channel(index).configure`: colors normalize to `#RRGGBB` (malformed
 * throws), contrast clamps into [0, 1] ordered low ≤ high.
 */
function normalizeChannelPatch(patch: ViewerChannelPatch, context: string): ViewerChannelPatch {
  if (patch === null || typeof patch !== "object") {
    throw new Error(`${context}: channel config must be an object, got ${JSON.stringify(patch)}`);
  }
  const out: ViewerChannelPatch = {};
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string") {
      throw new Error(`${context}: label must be a string, got ${JSON.stringify(patch.label)}`);
    }
    out.label = patch.label;
  }
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== "boolean") {
      throw new Error(`${context}: visible must be a boolean, got ${JSON.stringify(patch.visible)}`);
    }
    out.visible = patch.visible;
  }
  if (patch.color !== undefined) {
    const color = normalizeHexColor(typeof patch.color === "string" ? patch.color : undefined);
    if (!color) {
      throw new Error(`${context}: invalid color ${JSON.stringify(patch.color)} (expected #RRGGBB)`);
    }
    out.color = color;
  }
  if (patch.contrast !== undefined) {
    const c = patch.contrast;
    if (!Array.isArray(c) || c.length !== 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      throw new Error(`${context}: contrast must be a [min, max] number pair, got ${JSON.stringify(c)}`);
    }
    out.contrast = clampContrastLimits([c[0], c[1]]) as [number, number];
  }
  return out;
}

function normalizeCamera(value: ViewerCamera | undefined, context: string): ViewerCamera | undefined {
  if (value === undefined || value === "fit") return value;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context}: camera must be "fit" or a Partial<Camera>, got ${JSON.stringify(value)}`);
  }
  for (const key of ["position", "target", "up"] as const) {
    const v = value[key];
    if (v !== undefined && (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite))) {
      throw new Error(`${context}: camera.${key} must be a [x, y, z] number triple`);
    }
  }
  if (value.navMode !== undefined && value.navMode !== "orbit" && value.navMode !== "fly") {
    throw new Error(`${context}: camera.navMode must be "orbit" or "fly"`);
  }
  if (value.projMode !== undefined && value.projMode !== "perspective" && value.projMode !== "orthographic") {
    throw new Error(`${context}: camera.projMode must be "perspective" or "orthographic"`);
  }
  return { ...value };
}

function normalizeControls(
  value: ViewerControlsConfig | undefined,
  context: string,
): ViewerControlsConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context}: controls must be an object, got ${JSON.stringify(value)}`);
  }
  const out: ViewerControlsConfig = {};
  for (const key of Object.keys(value)) assertControlName(key);
  for (const name of CONTROL_NAMES) {
    const v: unknown = value[name];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[name] = v;
    else if (typeof v === "object" && v !== null) out[name] = { ...(v as object) } as never;
    else throw new Error(`${context}: controls.${name} must be a boolean or an options object`);
  }
  return out;
}

function normalizeTools(
  value: ViewerToolsConfig | undefined,
  context: string,
): ViewerToolsConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context}: tools must be an object, got ${JSON.stringify(value)}`);
  }
  const out: ViewerToolsConfig = {};
  for (const key of Object.keys(value)) assertToolName(key);
  for (const name of TOOL_NAMES) {
    const v: unknown = value[name];
    if (v === undefined) continue;
    if (name === "magnifier") {
      if (v === false || v === "2d" || v === "3d") out.magnifier = v;
      else if (typeof v === "object" && v !== null) {
        assertSerializableToolOptions(name, v as Record<string, unknown>, context);
        const dim = (v as ViewerMagnifierOptions).dimension;
        if (dim !== undefined && dim !== "2d" && dim !== "3d") {
          throw new Error(`${context}: tools.magnifier.dimension must be "2d" or "3d"`);
        }
        out.magnifier = { ...(v as ViewerMagnifierOptions) };
      } else {
        throw new Error(`${context}: tools.magnifier must be false, "2d", "3d", or an options object`);
      }
      continue;
    }
    if (typeof v === "boolean") out[name] = v as never;
    else if (typeof v === "object" && v !== null) {
      assertSerializableToolOptions(name, v as Record<string, unknown>, context);
      out[name] = { ...(v as object) } as never;
    }
    else throw new Error(`${context}: tools.${name} must be a boolean or an options object`);
  }
  return out;
}

function normalizeAutoRotate(value: ViewerConfig["autoRotate"]): ViewerConfig["autoRotate"] {
  if (value === undefined || typeof value === "boolean") return value;
  if (value === null || typeof value !== "object") {
    throw new Error(`config.autoRotate must be a boolean or { speedDegPerSec }, got ${JSON.stringify(value)}`);
  }
  if (value.speedDegPerSec !== undefined && !Number.isFinite(value.speedDegPerSec)) {
    throw new Error(`config.autoRotate.speedDegPerSec must be a finite number, got ${JSON.stringify(value.speedDegPerSec)}`);
  }
  return { ...value };
}

function normalizeTransform(value: unknown, context: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length !== 16 || !value.every(Number.isFinite)
  ) {
    throw new Error(`${context} must be an array of 16 finite numbers (4×4 column-major affine), got ${JSON.stringify(value)}`);
  }
  return [...value];
}

function normalizeModeOverrides(value: ViewerModeOverrides | undefined): ViewerModeOverrides {
  const out: ViewerModeOverrides = {};
  if (value === undefined) return out;
  if (value === null || typeof value !== "object") {
    throw new Error(`modeOverrides must be an object keyed by mode, got ${JSON.stringify(value)}`);
  }
  for (const [mode, override] of Object.entries(value)) {
    assertResolvedMode(mode);
    if (override === undefined) continue;
    const next: ViewerModeOverride = {};
    if (override.channels) {
      next.channels = override.channels.map((entry) => ({
        ...entry,
        ...normalizeChannelPatch(entry, `modeOverrides.${mode}.channels`),
      }));
    }
    const camera = normalizeCamera(override.camera, `modeOverrides.${mode}`);
    if (camera !== undefined) next.camera = camera;
    const controls = normalizeControls(override.controls, `modeOverrides.${mode}`);
    if (controls !== undefined) next.controls = controls;
    const tools = normalizeTools(override.tools, `modeOverrides.${mode}`);
    if (tools !== undefined) next.tools = tools;
    const transform = normalizeTransform(override.transform, `modeOverrides.${mode}.transform`);
    if (transform !== undefined) next.transform = transform;
    out[mode as ResolvedViewerMode] = next;
  }
  return out;
}

// ============================================================================
// TRANSLATION HELPERS (§15.5)
// ============================================================================

type ViewKind = "volume" | "slice";

/** Fallback framing for datasets that report no physical space ([0,1]³). */
const DEFAULT_PHYSICAL: PhysicalSpace = { spatial: { size: [1, 1, 1] } };

/** Quad layout: three orthogonal slice planes plus one volume view. */
const QUAD_PLANES = [
  { id: "quad-xy", axes: ["x", "y"] },
  { id: "quad-xz", axes: ["x", "z"] },
  { id: "quad-yz", axes: ["y", "z"] },
] as const;
const QUAD_VOLUME_ID = "quad-3d";
const MAIN_VIEW_ID = "main";

/** View id + kind pairs for a mode (drives per-view controls/tools). */
function viewEntriesForMode(mode: ResolvedViewerMode): { id: string; kind: ViewKind }[] {
  if (mode !== "quad") return [{ id: MAIN_VIEW_ID, kind: mode }];
  return [...QUAD_PLANES.map((p) => ({ id: p.id, kind: "slice" as const })), { id: QUAD_VOLUME_ID, kind: "volume" }];
}

/**
 * Await structural readiness of every unique layer generated for `mode`
 * (ARCH-1) — via each view that references it, so quad mode's layers spread
 * across four views are all covered.
 */
function awaitGeneratedLayersReady(
  engine : ViewerEngine,
  config : ViewerEngineConfig,
  mode   : ResolvedViewerMode,
): Promise<unknown> {
  const pending: Promise<unknown>[] = [];
  for (const { id } of viewEntriesForMode(mode)) {
    const view = engine.view(id);
    for (const layerId of config.views[id]?.layers ?? []) {
      pending.push(view.whenLayerReady(layerId));
    }
  }
  return Promise.all(pending);
}

/** Layer id prefixes for a mode — `<prefix>-c<channelIndex>` (`volume-c0`, `quad-xy-c0`, …). */
function layerPrefixesForMode(mode: ResolvedViewerMode): string[] {
  if (mode !== "quad") return [mode];
  return [...QUAD_PLANES.map((p) => p.id), QUAD_VOLUME_ID];
}

/** Expand the declarative control set into low-level `ViewConfig.controls`. */
function expandViewerControls(controls: ViewerControlsConfig): ControlOptions {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of CONTROL_NAMES) {
    const value = controls[name];
    if (value === undefined || value === false) continue;
    out[name] = value === true ? {} : { ...(value as Record<string, unknown>) };
  }
  return out as ControlOptions;
}

/** Expand the declarative tool set into low-level `ViewConfig.overlays`. */
function expandViewerTools(tools: ViewerToolsConfig | undefined, kind: ViewKind): OverlayOptions {
  const out: Record<string, Record<string, unknown>> = {};
  if (!tools) return out as OverlayOptions;
  const put = (type: string, value: boolean | object | undefined): void => {
    if (value === undefined || value === false) return;
    out[type] = value === true ? {} : { ...(value as Record<string, unknown>) };
  };
  put("crosshair", tools.crosshair);
  put("ruler", tools.ruler);
  put("roiselector", tools.roi);
  const magnifier = tools.magnifier;
  if (magnifier !== undefined && magnifier !== false) {
    let dimension: "2d" | "3d";
    let options: Record<string, unknown> = {};
    if (magnifier === "2d" || magnifier === "3d") {
      dimension = magnifier;
    } else {
      const { dimension: pin, ...rest } = magnifier;
      dimension = pin ?? (kind === "volume" ? "3d" : "2d");
      options = rest;
    }
    out[`magnifier-${dimension}`] = options;
  }
  return out as OverlayOptions;
}

/** Tool name → built-in overlay type(s) it maps to (DX-M6). */
function toolOverlayTypes(name: ViewerToolName): string[] {
  switch (name) {
    case "crosshair": return ["crosshair"];
    case "ruler":     return ["ruler"];
    case "roi":       return ["roiselector"];
    case "magnifier": return ["magnifier-2d", "magnifier-3d"];
  }
}

function mergeCamera(base: Camera, partial: Partial<Camera>): Camera {
  return {
    navMode  : partial.navMode ?? base.navMode,
    projMode : partial.projMode ?? base.projMode,
    position : partial.position ? [...partial.position] as Vec3 : [...base.position] as Vec3,
    target   : partial.target ? [...partial.target] as Vec3 : [...base.target] as Vec3,
    up       : partial.up ? [...partial.up] as Vec3 : base.up ? [...base.up] as Vec3 : undefined,
  };
}

/**
 * `"auto"` delegates to the dataset's declared presentation contract:
 * `capabilities.defaultMode` decides, exactly (e.g. 3D image datasets default
 * to volume, 2D to slice, meshes to volume).
 */
function resolveViewerMode(mode: ViewerMode, dataset: Dataset): ResolvedViewerMode {
  if (mode !== "auto") return mode;
  return dataset.capabilities.defaultMode;
}

// ============================================================================
// TARGET RESOLUTION
// ============================================================================

type ViewerTarget =
  | { kind: "canvas"; canvas: HTMLCanvasElement }
  | { kind: "container"; container: HTMLElement };

function isCanvasLike(el: unknown): el is HTMLCanvasElement {
  if (!el || typeof el !== "object") return false;
  if (typeof HTMLCanvasElement !== "undefined" && el instanceof HTMLCanvasElement) return true;
  return typeof (el as HTMLCanvasElement).getContext === "function";
}

function resolveTarget(element: string | HTMLElement | HTMLCanvasElement): ViewerTarget {
  let el: unknown = element;
  if (typeof element === "string") {
    if (typeof document === "undefined") {
      throw new Error(`createViewer: cannot resolve selector "${element}" — no document in this environment`);
    }
    el = document.querySelector(element);
    if (!el) throw new Error(`createViewer: no element matches selector "${element}"`);
  }
  if (isCanvasLike(el)) return { kind: "canvas", canvas: el };
  if (el && typeof (el as HTMLElement).appendChild === "function") {
    return { kind: "container", container: el as HTMLElement };
  }
  throw new Error(
    "createViewer: element must be a CSS selector, an HTMLElement container, or an HTMLCanvasElement",
  );
}

// ============================================================================
// VIEWER
// ============================================================================

/**
 * Viewer — one dataset session with modes, channels, camera, controls, and
 * tools. Create via {@link createViewer}; reach the low-level scene instance
 * through `viewer.engine` for advanced composition.
 */
export class Viewer {
  private readonly _target: ViewerTarget;

  // Declarative intent (mirrored by `viewer.config`).
  private _datasetConfig?: DatasetConfig;
  private _mode: ViewerMode = "auto";
  private _projection: ViewerProjection = "mip";
  private _cameraConfig: ViewerCamera = "fit";
  private _controlsConfig?: ViewerControlsConfig;
  private _toolsConfig?: ViewerToolsConfig;
  private _channelOverrides = new Map<number, ViewerChannelPatch>();
  private _modeOverrides: ViewerModeOverrides = {};
  private _theme?: ViewerConfig["theme"];
  private _autoRotate?: ViewerConfig["autoRotate"];

  // Runtime state.
  private _dataset?: Dataset;
  private _engine?: ViewerEngine;
  private _unsubscribe?: () => void;
  /**
   * Live overlay instances per view, keyed by the registry type they were
   * created with. Rebuilt on every scene rebuild by zipping the view config's
   * overlay keys with `getOverlays()` (createView instantiates in
   * `Object.entries` order); runtime attach/detach keeps it current. Needed
   * because instance classes do not reliably self-report their registry type
   * (e.g. the magnifier's static `overlayType` is always `"magnifier-2d"`).
   */
  private _liveOverlays = new Map<string, Map<string, BaseOverlay>>();
  private _status: ViewerStatus = "idle";
  private _error?: unknown;
  private _resolvedMode?: ResolvedViewerMode;
  private _pendingMode?: ResolvedViewerMode;
  private _focus?: Vec3;
  private _revision = 0;
  private _ready: Promise<Viewer>;
  private _destroyed = false;

  /**
   * High-level event subscriptions (API-4). They live on the Viewer — not on
   * any engine/overlay instance — so they survive open/mode rebuilds; the
   * forwarders are re-attached to each new scene's roiselector overlays.
   * Cleared on `destroy()`.
   */
  private readonly _eventHandlers: {
    [K in ViewerEventName]: Set<(event: ViewerEventMap[K]) => void>;
  } = {
    roiChange       : new Set(),
    roiActiveChange : new Set(),
  };

  // Viewer-owned DOM (container targets only).
  private _singleCanvas?: HTMLCanvasElement;
  private _quadGrid?: { el: HTMLElement; canvases: Record<string, HTMLCanvasElement> };

  constructor(target: ViewerTarget, config: ViewerConfig = {}) {
    this._target = target;
    if (config.mode !== undefined) assertViewerMode(config.mode);
    this._mode = config.mode ?? "auto";
    if (config.projection !== undefined) assertProjection(config.projection);
    this._projection = config.projection ?? "mip";
    this._cameraConfig = normalizeCamera(config.camera, "config") ?? "fit";
    this._controlsConfig = normalizeControls(config.controls, "config");
    this._toolsConfig = normalizeTools(config.tools, "config");
    for (const entry of config.channels ?? []) {
      if (!Number.isInteger(entry?.index) || entry.index < 0) {
        throw new Error(`config.channels: each entry needs a non-negative integer index, got ${JSON.stringify(entry)}`);
      }
      this._channelOverrides.set(
        entry.index,
        { ...this._channelOverrides.get(entry.index), ...normalizeChannelPatch(entry, "config.channels") },
      );
    }
    this._modeOverrides = normalizeModeOverrides(config.modeOverrides);
    this._theme = config.theme ? { ...config.theme } : undefined;
    this._autoRotate = normalizeAutoRotate(config.autoRotate);
    this._datasetConfig = config.dataset;
    this._ready = Promise.resolve(this);
  }

  // === Accessors ===

  /** The opened dataset, once open (decision 19.4 — `dataset` names the runtime object). */
  get dataset(): Dataset | undefined {
    return this._dataset;
  }

  /**
   * The low-level escape hatch (§15.1): the current ViewerEngine instance. Replaced
   * on `open()` and on mode transitions — do not cache it across either.
   * Undefined until the first successful open.
   */
  get engine(): ViewerEngine | undefined {
    return this._engine;
  }

  /** Load/transition status (DX-M2). */
  get status(): ViewerStatus {
    return this._status;
  }

  /** The recorded failure when `status === "error"` (DX-M2 cause chain). */
  get error(): unknown {
    return this._error;
  }

  /** Settles when the latest open/transition completes; rejects with its failure. */
  get ready(): Promise<Viewer> {
    return this._ready;
  }

  /** The configured mode (`"auto"` stays `"auto"`). */
  get mode(): ViewerMode {
    return this._mode;
  }

  /** The mode actually in effect after auto-resolution; undefined before the first open. */
  get resolvedMode(): ResolvedViewerMode | undefined {
    return this._resolvedMode;
  }

  /**
   * Modes the current dataset can build, intersected with what the target
   * layout can host (a caller-owned canvas cannot host `"quad"`). Before the
   * first open — no dataset — every target-hostable mode is listed.
   */
  get availableModes(): ResolvedViewerMode[] {
    const modes = this._dataset?.capabilities.modes ?? RESOLVED_MODES;
    return modes.filter((mode) => this._targetSupports(mode));
  }

  get projection(): ViewerProjection {
    return this._projection;
  }

  /** The primary canvas (the user canvas, or the viewer-owned one once created). */
  get canvas(): HTMLCanvasElement | undefined {
    if (this._target.kind === "canvas") return this._target.canvas;
    return this._singleCanvas ?? this._quadGrid?.canvases[QUAD_PLANES[0].id];
  }

  /**
   * The current declarative config — pure JSON (callbacks/runtime resources
   * are excluded by design, §15.2). Imperative changes are reflected here,
   * which is what makes the declarative/imperative parity (§15.4) testable.
   */
  get config(): ViewerConfig {
    const config: ViewerConfig = {};
    if (this._datasetConfig) config.dataset = this._datasetConfig;
    config.mode = this._mode;
    const channels = this._dataset
      ? this._baseChannels().map((c) => ({ ...c, contrast: [...c.contrast] as [number, number] }))
      : [...this._channelOverrides.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, patch]) => ({ index, ...patch }) as ViewerChannelConfig);
    if (channels.length > 0) config.channels = channels;
    config.projection = this._projection;
    config.camera = this._cameraConfig === "fit" ? "fit" : { ...this._cameraConfig };
    if (this._controlsConfig) config.controls = this._controlsConfig;
    if (this._toolsConfig) config.tools = this._toolsConfig;
    if (Object.keys(this._modeOverrides).length > 0) config.modeOverrides = this._modeOverrides;
    if (this._theme) config.theme = this._theme;
    if (this._autoRotate !== undefined) {
      config.autoRotate = typeof this._autoRotate === "object" ? { ...this._autoRotate } : this._autoRotate;
    }
    // Round-trip through JSON: proves the mirrored schema stays function-free
    // (functions are rejected at entry by the tools validation — API-4).
    return JSON.parse(JSON.stringify(config)) as ViewerConfig;
  }

  // === Open / status (DX-M2) ===

  /**
   * Open (or replace) the dataset from a declarative config: a fresh Dataset
   * is constructed and loaded through the dataset registry, then owned by the
   * Viewer. Resolves with the dataset once ready; rejects with the load error
   * as-is (`cause` chains preserved) when the source fails, or with
   * {@link ViewerSupersededError} when a newer open/transition wins.
   * Last-write-wins: a superseded open never clobbers newer state.
   */
  open(config: DatasetConfig): Promise<Dataset>;
  /**
   * Adopt an already-loaded Dataset (API-5 — e.g. one pre-opened via
   * `openOMEZarrDataset` for its format metadata). Ownership transfers AT
   * INVOCATION: after this call the caller must not dispose the instance,
   * even if the returned promise rejects — the Viewer disposes it on
   * supersession, replacement by a newer open, rebuild failure, and
   * {@link destroy}. (An invocation that itself THROWS — e.g. on a destroyed
   * viewer — never transfers ownership.) Same settlement contract as the
   * config overload.
   */
  open(dataset: Dataset): Promise<Dataset>;
  async open(source: DatasetConfig | Dataset): Promise<Dataset> {
    this._assertUsable("open");
    const revision = ++this._revision;
    this._datasetConfig = source instanceof Dataset ? source.config : source;
    this._error = undefined;
    this._status = "loading";
    const op = this._runOpen(source, revision);
    this._track(op);
    return op;
  }

  private async _runOpen(source: DatasetConfig | Dataset, revision: number): Promise<Dataset> {
    let dataset: Dataset;
    if (source instanceof Dataset) {
      // Adoption (API-5): ownership transferred at invocation — from here on
      // only the Viewer disposes this instance. No load, no second open.
      dataset = source;
    } else {
      try {
        dataset = await openDataset(source);
      } catch (err) {
        if (this._isCurrent(revision)) {
          this._error = err;
          this._status = "error";
        }
        throw err;
      }
    }
    this._assertCurrent(revision, "open", () => dataset.dispose());
    // The new dataset won the race — release the previous one (never the new
    // instance itself: re-adopting the live dataset must not dispose it).
    if (this._dataset !== dataset) this._dataset?.dispose();
    this._dataset = dataset;
    const mode = resolveViewerMode(this._mode, dataset);
    try {
      this._assertModeSupported(mode);
    } catch (err) {
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    try {
      await this._rebuild(revision, mode, undefined);
    } catch (err) {
      // Rebuild failure while this open is still current: the Viewer disposes
      // the dataset it owns (API-5). A superseded open's dataset was already
      // released by the winning replacement (or is still live under a newer
      // mode transition) — never dispose twice.
      if (this._isCurrent(revision)) {
        dataset.dispose();
        if (this._dataset === dataset) this._dataset = undefined;
      }
      throw err;
    }
    return dataset;
  }

  // === Mode transitions (DX-L2) ===

  /**
   * Whether the target layout can host `mode`: a caller-owned canvas is a
   * single view — `"quad"` needs the Viewer to own the 2×2 layout, so it is
   * only available on selector/container targets.
   */
  private _targetSupports(mode: ResolvedViewerMode): boolean {
    return mode !== "quad" || this._target.kind !== "canvas";
  }

  /**
   * Reject a resolved mode the current dataset or target cannot host. Thrown
   * BEFORE any engine teardown/rebuild, so a rejected assignment leaves the
   * running scene untouched.
   */
  private _assertModeSupported(mode: ResolvedViewerMode): void {
    const datasetModes = this._dataset?.capabilities.modes ?? [];
    if (!datasetModes.includes(mode)) {
      throw new Error(
        `Mode "${mode}" is not supported by dataset kind "${this._dataset?.type}" ` +
        `(available: ${datasetModes.join(", ") || "none"}). ` +
        "Check viewer.availableModes before assigning.",
      );
    }
    if (!this._targetSupports(mode)) {
      throw new Error(
        'viewer.mode = "quad" requires a container element (the Viewer lays out four ' +
        "canvases); pass a container to createViewer instead of a canvas",
      );
    }
  }

  /**
   * Switch visualization mode. Synchronous to call, asynchronous to complete
   * — `await viewer.ready` observes completion. Transitions preserve the
   * physical focus (the camera target survives; the new mode's fit framing is
   * translated onto it) and channel intent (the channel model reapplies to
   * the new mode's layers). Last-write-wins: rapid flips settle on the final
   * mode. Assigning a mode the dataset or target cannot host throws before
   * anything is torn down.
   */
  set mode(value: ViewerMode) {
    this._assertUsable("mode");
    assertViewerMode(value);
    if (!this._dataset) {
      this._mode = value; // intent recorded; resolved + validated on open
      return;
    }
    const mode = resolveViewerMode(value, this._dataset);
    this._assertModeSupported(mode);
    this._mode = value;
    if (mode === this._pendingMode) return; // already the latest intent
    this._pendingMode = mode;
    const revision = ++this._revision;
    this._track(this._rebuild(revision, mode, this._focus));
  }

  // === Channels (DX-M3) ===

  /**
   * Channel-level access — one operation per channel, no layer-ID scans.
   * The channel's config maps to the internal typed volume/slice layers
   * (nested `options.selection.c`).
   */
  channel(index: number): ViewerChannelAccessor {
    this._assertUsable("channel");
    if (!this._dataset) {
      throw new Error("viewer.channel(): no dataset open — call viewer.open() first");
    }
    if (!Number.isInteger(index) || index < 0 || index >= this._dataset.channels.length) {
      throw new Error(
        `viewer.channel(${index}): index out of range — the dataset has ` +
        `${this._dataset.channels.length} channel(s) (valid: 0..${this._dataset.channels.length - 1})`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get config(): ViewerChannelState {
        const channel = self._effectiveChannels(self._resolvedMode ?? "slice")
          .find((c) => c.index === index)!;
        return { ...channel, contrast: [...channel.contrast] as [number, number] };
      },
      configure(patch: ViewerChannelPatch): void {
        const normalized = normalizeChannelPatch(patch, `viewer.channel(${index}).configure`);
        self._channelOverrides.set(index, { ...self._channelOverrides.get(index), ...normalized });
        // Edit-what-you-see: when the ACTIVE mode carries its own channel
        // override (modeOverrides), a base-only edit would be masked by it in
        // the live apply. Merge the patch into the active mode's override too,
        // so the edit takes effect immediately and `viewer.config` mirrors
        // what the user sees.
        const mode = self._resolvedMode;
        const overrideChannels = mode ? self._modeOverrides[mode]?.channels : undefined;
        if (mode && overrideChannels?.some((c) => c.index === index)) {
          self._modeOverrides[mode] = {
            ...self._modeOverrides[mode],
            channels: overrideChannels.map((c) => (c.index === index ? { ...c, ...normalized } : c)),
          };
        }
        self._applyChannelLive(index);
      },
    };
  }

  /** Every channel's effective config (dataset defaults + overrides + active mode override). */
  get channels(): ViewerChannelState[] {
    if (!this._dataset) return [];
    return this._effectiveChannels(this._resolvedMode ?? "slice")
      .map((c) => ({ ...c, contrast: [...c.contrast] as [number, number] }));
  }

  // === Projection (DX-Q5) ===

  /** Volume accumulation projection — maps to `render.volumeProjection` on volume layers. */
  set projection(value: ViewerProjection) {
    this._assertUsable("projection");
    assertProjection(value);
    this._projection = value;
    if (!this._engine || !this._resolvedMode) return;
    for (const id of this._volumeLayerIds(this._resolvedMode)) {
      this._engine.layer(id)?.setRender({ volumeProjection: value });
    }
  }

  // === Camera ===

  /**
   * `"fit"` reframes the dataset bounds (same as {@link fitCamera}); a
   * `Partial<Camera>` merges over the CURRENT camera. At config time the
   * current camera IS the fit camera, so config and imperative paths agree.
   */
  setCamera(value: ViewerCamera): void {
    this._assertUsable("setCamera");
    const normalized = normalizeCamera(value, "viewer.setCamera") ?? "fit";
    this._cameraConfig = normalized;
    if (!this._engine) return;
    if (normalized === "fit") {
      this.fitCamera();
      return;
    }
    const state = this._engine.getState();
    state.exploration.camera = mergeCamera(state.exploration.camera, normalized);
    this._engine.setState(state);
  }

  /** Reframe the dataset bounds for the current mode via the existing fit helpers. */
  fitCamera(): void {
    this._assertUsable("fitCamera");
    if (!this._engine || !this._resolvedMode || !this._dataset) return;
    const state = this._engine.getState();
    state.exploration.camera = this._fitCamera(this._resolvedMode);
    this._engine.setState(state);
  }

  /**
   * Move the slice position of the active slice/quad mode: every slice layer
   * shows the slice at `point` along its through axis, and the camera focus is
   * translated onto `point` (position↔target offset preserved, same as mode
   * transitions). No-op before open or in volume mode.
   */
  setSlicePoint(point: Vec3): void {
    this._assertUsable("setSlicePoint");
    const engine = this._engine;
    const mode = this._resolvedMode;
    if (!engine || !mode) return;
    if (!viewEntriesForMode(mode).some((entry) => entry.kind === "slice")) return;
    this._syncSliceLayers(mode, point);
    const state = engine.getState();
    const camera = state.exploration.camera;
    const delta: Vec3 = [
      point[0] - camera.target[0],
      point[1] - camera.target[1],
      point[2] - camera.target[2],
    ];
    state.exploration.camera = {
      ...camera,
      target   : [...point] as Vec3,
      position : [
        camera.position[0] + delta[0],
        camera.position[1] + delta[1],
        camera.position[2] + delta[2],
      ] as Vec3,
    };
    engine.setState(state);
    this._focus = [...point] as Vec3;
  }

  // === Controls and tools (DX-M6) ===

  /**
   * Runtime control access with the same typed options as the declarative
   * `controls` key. Controls are creation-only at the low level; the Viewer
   * re-instantiates the view's control chain through the control registry so
   * declarative and imperative paths agree (DX-M6).
   */
  control<K extends ViewerControlName>(name: K): ViewerControlAccessor<ViewerControlOptionsMap[K]> {
    this._assertUsable("control");
    assertControlName(name);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get enabled(): boolean {
        return self._isControlEnabled(name);
      },
      configure(options: Partial<ViewerControlOptionsMap[K]>): void {
        if (!options || typeof options !== "object") {
          throw new Error(`viewer.control("${name}").configure: options must be an object`);
        }
        const controls = { ...(self._controlsConfig ?? self._defaultControlsConfig()) };
        const prev = controls[name];
        controls[name] = { ...(prev && typeof prev === "object" ? prev : {}), ...options } as never;
        self._controlsConfig = controls;
        self._applyControlsLive();
      },
      enable(enabled = true): void {
        const controls = { ...(self._controlsConfig ?? self._defaultControlsConfig()) };
        const prev = controls[name];
        controls[name] = (enabled ? (prev && typeof prev === "object" ? prev : {}) : false) as never;
        self._controlsConfig = controls;
        self._applyControlsLive();
      },
    };
  }

  /**
   * Runtime tool access with the same typed options as the declarative
   * `tools` key. Tools map to built-in overlays (crosshair/ruler/roiselector/
   * magnifier-2d/3d) attached to the current mode's views.
   */
  tool<K extends ViewerToolName>(name: K): ViewerToolAccessor<ViewerToolOptionsMap[K]> {
    this._assertUsable("tool");
    assertToolName(name);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get enabled(): boolean {
        return self._isToolEnabled(name);
      },
      configure(options: Partial<ViewerToolOptionsMap[K]>): void {
        if (!options || typeof options !== "object") {
          throw new Error(`viewer.tool("${name}").configure: options must be an object`);
        }
        assertSerializableToolOptions(
          name,
          options as Record<string, unknown>,
          `viewer.tool("${name}").configure`,
        );
        if (name === "magnifier") {
          const dim = (options as ViewerMagnifierOptions).dimension;
          if (dim !== undefined && dim !== "2d" && dim !== "3d") {
            throw new Error(`viewer.tool("magnifier").configure: dimension must be "2d" or "3d"`);
          }
        }
        const tools = { ...(self._toolsConfig ?? {}) };
        const prev = tools[name];
        tools[name] = { ...(prev && typeof prev === "object" ? prev : {}), ...options } as never;
        self._toolsConfig = tools;
        self._applyToolLive(name);
      },
      enable(enabled = true): void {
        const tools = { ...(self._toolsConfig ?? {}) };
        const prev = tools[name];
        // The magnifier schema has no bare `true` (a dimension or options bag
        // is required); enabling it fresh uses `{}` — kind-default dimension.
        tools[name] = (enabled
          ? (prev === undefined || prev === false ? (name === "magnifier" ? {} : true) : prev)
          : false) as never;
        self._toolsConfig = tools;
        self._applyToolLive(name);
      },
    };
  }

  // === Mode overrides ===

  /**
   * Imperative equivalent of `modeOverrides[mode]` (§15.4): merge per-mode
   * overrides; applies immediately (with focus preservation) when that mode
   * is the active one.
   */
  view(mode: ResolvedViewerMode): ViewerViewAccessor {
    this._assertUsable("view");
    assertResolvedMode(mode);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      configure(value: ViewerModeOverride): void {
        const normalized = normalizeModeOverrides({ [mode]: value })[mode] ?? {};
        const prev = self._modeOverrides[mode] ?? {};
        const next: ViewerModeOverride = { ...prev };
        if (normalized.channels) {
          const byIndex = new Map((prev.channels ?? []).map((c) => [c.index, c]));
          for (const entry of normalized.channels) {
            byIndex.set(entry.index, { ...byIndex.get(entry.index), ...entry });
          }
          next.channels = [...byIndex.values()].sort((a, b) => a.index - b.index);
        }
        if (normalized.camera !== undefined) next.camera = normalized.camera;
        if (normalized.controls !== undefined) next.controls = { ...prev.controls, ...normalized.controls };
        if (normalized.tools !== undefined) next.tools = { ...prev.tools, ...normalized.tools };
        if (normalized.transform !== undefined) next.transform = normalized.transform;
        self._modeOverrides[mode] = next;
        if (self._dataset && self._resolvedMode === mode) self._reenter();
      },
    };
  }

  // === Events (API-4) ===

  /**
   * Subscribe to a high-level Viewer runtime event (API-4) — the typed
   * counterpart of the low-level overlay callbacks. Returns an unsubscribe
   * function. One overlay change produces exactly one event, carrying the
   * interacting view's id and the mode in effect. Subscriptions live on the
   * Viewer, so they survive open/mode rebuilds; `destroy()` clears them.
   */
  on<K extends ViewerEventName>(
    name    : K,
    handler : (event: ViewerEventMap[K]) => void,
  ): () => void {
    this._assertUsable("on");
    assertEventName(name);
    if (typeof handler !== "function") {
      throw new Error(`viewer.on("${name}"): handler must be a function, got ${typeof handler}`);
    }
    const handlers = this._eventHandlers[name] as Set<(event: ViewerEventMap[K]) => void>;
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  // === Teardown ===

  /** Destroy the low-level instance, dispose the dataset, detach viewer-owned DOM, supersede in-flight work. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._revision; // supersede any in-flight open/transition
    for (const handlers of Object.values(this._eventHandlers)) handlers.clear();
    this._teardownEngine();
    this._dataset?.dispose();
    this._dataset = undefined;
    this._removeOwnedDom();
    this._status = "idle";
    this._error = undefined;
  }

  // ==================================================================
  // INTERNALS
  // ==================================================================

  private _assertUsable(operation: string): void {
    if (this._destroyed) throw new Error(`viewer.${operation}: the Viewer has been destroyed`);
  }

  private _isCurrent(revision: number): boolean {
    return !this._destroyed && revision === this._revision;
  }

  private _assertCurrent(revision: number, operation: string, cleanup?: () => void): void {
    if (this._isCurrent(revision)) return;
    cleanup?.();
    throw new ViewerSupersededError(operation);
  }

  /** Track the latest operation; `ready` settles with it. */
  private _track(op: Promise<unknown>): void {
    const ready = op.then(() => this);
    // Keep rejections observable via `ready` without unhandled-rejection noise
    // for fire-and-forget callers.
    ready.catch(() => {});
    this._ready = ready;
  }

  private _teardownEngine(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    const engine = this._engine;
    this._engine = undefined;
    this._liveOverlays.clear();
    engine?.destroy();
  }

  /**
   * Rebuild the low-level scene for `mode`: destroy the current ViewerEngine,
   * translate the viewer state into a fresh ViewerEngineConfig (§15.5), and
   * delegate creation/mounting to `createViewerEngine`. `focus` is the physical
   * point to preserve (mode transitions); undefined fits the dataset bounds.
   */
  private async _rebuild(revision: number, mode: ResolvedViewerMode, focus: Vec3 | undefined): Promise<void> {
    this._status = "loading";
    this._teardownEngine();

    let engine: ViewerEngine;
    let config: ViewerEngineConfig;
    try {
      const canvases = this._ensureCanvases(mode);
      config = this._buildViewerEngineConfig(mode, canvases, focus);
      engine = await createViewerEngine(config);
    } catch (err) {
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    this._assertCurrent(revision, "mode transition", () => engine.destroy());
    this._engine = engine;
    this._resolvedMode = mode;
    this._pendingMode = mode;
    this._focus = [...engine.getState().exploration.camera.target] as Vec3;
    this._unsubscribe = engine.subscribe((state) => {
      this._focus = [...state.exploration.camera.target] as Vec3;
    });
    // Zip the built overlay keys onto the live instances (createView
    // instantiates in Object.entries order).
    for (const { id } of viewEntriesForMode(mode)) {
      const keys = Object.keys(config.views[id].overlays ?? {});
      const instances = engine.view(id).base.getOverlays();
      const byType = new Map<string, BaseOverlay>();
      keys.forEach((type, i) => byType.set(type, instances[i]));
      this._liveOverlays.set(id, byType);
      // API-4: forward ROI overlay changes to the Viewer event surface.
      const roiOverlay = byType.get("roiselector");
      if (roiOverlay) this._wireRoiOverlay(roiOverlay, id);
    }

    const activeViewId = mode === "quad" ? QUAD_PLANES[0].id : MAIN_VIEW_ID;
    engine.setActiveView(activeViewId);

    // Slice layers default to the center slice; a preserved focus must show
    // the slice AT the focus (DX-L2 focus preservation covers what is shown,
    // not just where the camera looks).
    if (focus) this._syncSliceLayers(mode, focus);

    // ARCH-1: await structural readiness of every unique generated layer
    // before reporting ready, through every view that references one
    // (quad's layers live across four views — the active view alone does
    // not see them all). Tiled layers resolve immediately — readiness means
    // source/pyramid available, NOT full tile refinement. Source-backed
    // layers (e.g. surfaces) settle once fetched/parsed, and a source
    // failure rejects with the recorded load error.
    try {
      await awaitGeneratedLayersReady(engine, config, mode);
    } catch (err) {
      // A superseded rebuild's waiters reject on engine teardown — the
      // supersession error wins over the teardown reason.
      this._assertCurrent(revision, "mode transition", () => engine.destroy());
      this._error = err;
      this._status = "error";
      throw err;
    }
    this._assertCurrent(revision, "mode transition");
    this._error = undefined;
    this._status = "ready";
  }

  /** Re-apply the current mode (mode-override change on the active mode). */
  private _reenter(): void {
    if (!this._resolvedMode) return;
    const revision = ++this._revision;
    this._track(this._rebuild(revision, this._resolvedMode, this._focus));
  }

  // === Event internals (API-4) ===

  private _emit<K extends ViewerEventName>(name: K, event: ViewerEventMap[K]): void {
    const handlers = this._eventHandlers[name] as Set<(event: ViewerEventMap[K]) => void>;
    for (const handler of handlers) handler(event);
  }

  /**
   * Attach the ROI event forwarders to a live roiselector overlay (API-4).
   * Runs on every scene rebuild and on runtime tool attach, so Viewer-level
   * subscriptions keep firing across engine rebuilds. The overlay only ever
   * sees the forwarders — user callbacks never enter the overlay options
   * through the high-level surface. View/mode identity resolves at event time.
   */
  private _wireRoiOverlay(overlay: BaseOverlay, viewId: string): void {
    overlay.setOptions({
      onRoisChange: (rois: RoiBox[], change: RoiSelectionChange) => {
        const mode = this._resolvedMode;
        if (!mode) return;
        this._emit("roiChange", { rois, change, viewId, mode });
      },
      onActiveIndexChange: (activeIndex: number | null) => {
        const mode = this._resolvedMode;
        if (!mode) return;
        this._emit("roiActiveChange", { activeIndex, viewId, mode });
      },
    });
  }

  // === Translation (§15.5) ===

  private _requireDataset(): Dataset {
    if (!this._dataset) throw new Error("No dataset open — call viewer.open() first");
    return this._dataset;
  }

  /** Dataset channels + base overrides (no mode override) — the declarative `channels` mirror. */
  private _baseChannels(): ViewerChannelState[] {
    const dataset = this._requireDataset();
    return dataset.channels.map((channel) => {
      const patch = this._channelOverrides.get(channel.index) ?? {};
      return {
        index    : channel.index,
        label    : patch.label ?? channel.label,
        visible  : patch.visible ?? channel.visible,
        color    : patch.color ?? channel.color,
        contrast : (patch.contrast ?? channel.contrast) as [number, number],
      };
    });
  }

  /** Effective channels for `mode`: dataset defaults + base overrides + the mode override. */
  private _effectiveChannels(mode: ResolvedViewerMode): ViewerChannelState[] {
    const base = this._baseChannels();
    const override = this._modeOverrides[mode]?.channels;
    if (!override || override.length === 0) return base;
    const patches = new Map<number, ViewerChannelPatch>();
    for (const entry of override) {
      patches.set(entry.index, {
        ...patches.get(entry.index),
        ...normalizeChannelPatch(entry, `modeOverrides.${mode}.channels`),
      });
    }
    return base.map((channel) => {
      const patch = patches.get(channel.index);
      if (!patch) return channel;
      return {
        index    : channel.index,
        label    : patch.label ?? channel.label,
        visible  : patch.visible ?? channel.visible,
        color    : patch.color ?? channel.color,
        contrast : (patch.contrast ?? channel.contrast) as [number, number],
      };
    });
  }

  /** Layer IDs of the mode's VOLUME layers (projection targets). */
  private _volumeLayerIds(mode: ResolvedViewerMode): string[] {
    const dataset = this._requireDataset();
    const prefixes = mode === "volume" ? ["volume"] : mode === "quad" ? [QUAD_VOLUME_ID] : [];
    const ids: string[] = [];
    for (const prefix of prefixes) {
      for (const channel of dataset.channels) ids.push(`${prefix}-c${channel.index}`);
    }
    return ids;
  }

  /**
   * Push the slice containing `point` into every slice layer of `mode`
   * (per-view through axis, clamped to the layer's own range by the layer).
   * Slice layers default to the center slice, so mode entry with a preserved
   * focus and explicit `setSlicePoint` calls both go through here.
   */
  private _syncSliceLayers(mode: ResolvedViewerMode, point: Vec3): void {
    const engine = this._engine;
    if (!engine || mode === "volume") return;
    const dataset = this._requireDataset();
    const spatial = dataset.physical?.spatial;
    const spacing = spatial?.spacing ?? [1, 1, 1];
    const origin = spatial?.origin ?? [0, 0, 0];
    // Slice-layer prefixes with their in-plane axes: the mode name for the
    // main view (layers are `<mode>-cN`), the plane ids in quad.
    const planes: { prefix: string; axes: readonly string[] }[] = mode === "quad"
      ? QUAD_PLANES.map((p) => ({ prefix: p.id, axes: p.axes }))
      : [{ prefix: mode, axes: ["x", "y"] }];
    for (const { prefix, axes } of planes) {
      const through = resolveAxes(axes)[2];
      const index = Math.round((point[through] - origin[through]) / spacing[through]);
      for (const channel of dataset.channels) {
        engine.layer(`${prefix}-c${channel.index}`)?.setOptions({ sliceIndex: index });
      }
    }
  }

  private _controlsFor(mode: ResolvedViewerMode, kind: ViewKind): ControlOptions {
    const declared = this._modeOverrides[mode]?.controls ?? this._controlsConfig;
    if (declared !== undefined) return expandViewerControls(declared);
    return (kind === "volume" ? { orbit: {} } : { panzoom: {} }) as ControlOptions;
  }

  private _overlaysFor(mode: ResolvedViewerMode, kind: ViewKind): OverlayOptions {
    const tools = this._modeOverrides[mode]?.tools ?? this._toolsConfig;
    return expandViewerTools(tools, kind);
  }

  private _fitCamera(mode: ResolvedViewerMode): Camera {
    const physical = this._requireDataset().physical ?? DEFAULT_PHYSICAL;
    return mode === "slice"
      ? fitSliceCamera([0, 1, 2], physical)
      : frameVolumeCamera(physical);
  }

  /**
   * Camera for entering `mode`: the mode's fit framing, merged with the
   * declared camera (base config, then mode override), then translated onto
   * the preserved physical focus. An explicit `target` wins over the
   * preserved focus; a mode override of `camera: "fit"` forces a re-fit
   * (drops the preserved focus).
   */
  private _cameraFor(mode: ResolvedViewerMode, focus: Vec3 | undefined): Camera {
    const fit = this._fitCamera(mode);
    const overrideCamera = this._modeOverrides[mode]?.camera;
    const declared = overrideCamera ?? this._cameraConfig;
    let camera = fit;
    let explicitTarget = false;
    if (declared !== "fit") {
      camera = mergeCamera(fit, declared);
      explicitTarget = declared.target !== undefined;
    }
    if (focus && overrideCamera !== "fit" && !explicitTarget) {
      const delta: Vec3 = [
        focus[0] - camera.target[0],
        focus[1] - camera.target[1],
        focus[2] - camera.target[2],
      ];
      camera = {
        ...camera,
        target   : [...focus] as Vec3,
        position : [
          camera.position[0] + delta[0],
          camera.position[1] + delta[1],
          camera.position[2] + delta[2],
        ] as Vec3,
      };
    }
    return camera;
  }

  private _buildViewerEngineConfig(
    mode: ResolvedViewerMode,
    canvases: Record<string, HTMLCanvasElement>,
    focus: Vec3 | undefined,
  ): ViewerEngineConfig {
    const dataset = this._requireDataset();
    const channels = this._effectiveChannels(mode);
    // Layer config (not runtime mutation): the mode's declared transform is
    // baked into every constructed layer's `data.transform`, so it survives
    // open/mode-transition rebuilds by construction.
    const transform = this._modeOverrides[mode]?.transform;
    const physical: PhysicalSpace = {
      ...(dataset.physical ?? DEFAULT_PHYSICAL),
      channels: { names: channels.map((c) => c.label) },
    };
    const layers: LayerConfig[] = [];
    const views: Record<string, ViewConfig> = {};

    // Default layers come from the dataset kind (DX-M1): it knows how to
    // stamp its own per-channel volume/slice layers.
    const pushLayers = (prefix: string, kind: ViewKind, axes?: readonly string[]): string[] => {
      const configs = dataset.createDefaultLayers({
        view   : kind,
        prefix,
        axes,
        channels,
        ...(kind === "volume" ? { projection: this._projection } : {}),
        ...(transform !== undefined ? { transform: [...transform] } : {}),
      });
      layers.push(...configs);
      return configs.map((layer) => layer.id);
    };

    if (mode === "quad") {
      for (const plane of QUAD_PLANES) {
        views[plane.id] = {
          type     : "slice",
          canvas   : canvases[plane.id],
          layers   : pushLayers(plane.id, "slice", plane.axes),
          controls : this._controlsFor(mode, "slice"),
          overlays : this._overlaysFor(mode, "slice"),
        };
      }
      views[QUAD_VOLUME_ID] = {
        type     : "volume",
        canvas   : canvases[QUAD_VOLUME_ID],
        layers   : pushLayers(QUAD_VOLUME_ID, "volume"),
        controls : this._controlsFor(mode, "volume"),
        overlays : this._overlaysFor(mode, "volume"),
        ...(this._autoRotate ? { autoRotate: this._autoRotate } : {}),
      };
    } else {
      views[MAIN_VIEW_ID] = {
        type     : mode,
        canvas   : canvases[MAIN_VIEW_ID],
        layers   : pushLayers(mode, mode),
        controls : this._controlsFor(mode, mode),
        overlays : this._overlaysFor(mode, mode),
        ...(mode === "volume" && this._autoRotate ? { autoRotate: this._autoRotate } : {}),
      };
    }

    return {
      state: {
        physical,
        layers,
        exploration: { camera: this._cameraFor(mode, focus) },
      },
      views,
      ...(this._theme ? { theme: this._theme } : {}),
    };
  }

  // === Live application (imperative paths) ===

  private _applyChannelLive(index: number): void {
    const engine = this._engine;
    const mode = this._resolvedMode;
    if (!engine || !mode) return;
    const channel = this._effectiveChannels(mode).find((c) => c.index === index)!;
    const render: Partial<Render> = {
      visible        : channel.visible,
      color          : channel.color,
      contrastLimits : [...channel.contrast] as [number, number],
    };
    for (const prefix of layerPrefixesForMode(mode)) {
      engine.layer(`${prefix}-c${index}`)?.setRender(render);
    }
    // Channel labels live in the shared physical space.
    const state = engine.getState();
    if (state.physical?.channels) {
      state.physical = {
        ...state.physical,
        channels: {
          ...state.physical.channels,
          names: this._effectiveChannels(mode).map((c) => c.label),
        },
      };
      engine.setState(state);
    }
  }

  private _applyControlsLive(): void {
    const engine = this._engine;
    const mode = this._resolvedMode;
    if (!engine || !mode) return;
    for (const { id, kind } of viewEntriesForMode(mode)) {
      const options = this._controlsFor(mode, kind);
      const controls: BaseControl[] = [];
      for (const [type, opts] of Object.entries(options)) {
        if (!opts) continue;
        controls.push(controlRegistry.create(type, `viewer-${id}-${type}`, opts as Record<string, unknown>));
      }
      engine.view(id).base.setControls(controls);
    }
  }

  private _applyToolLive(name: ViewerToolName): void {
    const engine = this._engine;
    const mode = this._resolvedMode;
    if (!engine || !mode) return;
    for (const { id, kind } of viewEntriesForMode(mode)) {
      const desired = this._overlaysFor(mode, kind);
      const base = engine.view(id).base;
      const live = this._liveOverlays.get(id) ?? new Map<string, BaseOverlay>();
      this._liveOverlays.set(id, live);
      for (const type of toolOverlayTypes(name)) {
        const existing = live.get(type);
        const options = desired[type];
        if (options) {
          if (existing) {
            existing.setOptions(options);
          } else {
            const overlay: BaseOverlay = overlayRegistry.create(type);
            overlay.setOptions(options);
            base.addOverlay(overlay);
            live.set(type, overlay);
            // API-4: forward ROI overlay changes to the Viewer event surface.
            if (type === "roiselector") this._wireRoiOverlay(overlay, id);
            const parent = base.canvasElement?.parentElement;
            if (parent) {
              try {
                overlay.mount(parent);
              } catch (e) {
                console.warn("Overlay mount failed", e);
              }
            }
          }
        } else if (existing) {
          base.removeOverlay(existing);
          live.delete(type);
        }
      }
    }
    engine.requestRender();
  }

  private _defaultControlsConfig(): ViewerControlsConfig {
    const mode = this._resolvedMode ?? "slice";
    if (mode === "volume") return { orbit: true };
    if (mode === "quad") return { panzoom: true, orbit: true };
    return { panzoom: true };
  }

  private _isControlEnabled(name: ViewerControlName): boolean {
    const mode = this._resolvedMode;
    if (!mode) return false;
    const declared = this._modeOverrides[mode]?.controls ?? this._controlsConfig;
    if (declared !== undefined) {
      const value = declared[name];
      return value !== undefined && value !== false;
    }
    const defaults = this._defaultControlsConfig();
    return defaults[name] !== undefined && defaults[name] !== false;
  }

  private _isToolEnabled(name: ViewerToolName): boolean {
    const mode = this._resolvedMode;
    if (!mode) return false;
    const tools = this._modeOverrides[mode]?.tools ?? this._toolsConfig;
    const value = tools?.[name];
    if (value === undefined || value === false) return false;
    if (typeof value === "object" && (value as { visible?: boolean }).visible === false) return false;
    return true;
  }

  // === DOM ownership ===

  private _ownerDocument(container: HTMLElement): Document {
    const doc = container.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
    if (!doc) {
      throw new Error("createViewer: container targets need a DOM document in this environment");
    }
    return doc;
  }

  private _ensureCanvases(mode: ResolvedViewerMode): Record<string, HTMLCanvasElement> {
    if (this._target.kind === "canvas") {
      if (mode === "quad") {
        throw new Error(
          'mode "quad" requires a container element (the Viewer lays out four canvases); ' +
          "pass a container to createViewer instead of a canvas",
        );
      }
      return { [MAIN_VIEW_ID]: this._target.canvas };
    }
    const container = this._target.container;
    if (mode === "quad") {
      this._removeSingleCanvas();
      if (!this._quadGrid) {
        const doc = this._ownerDocument(container);
        const grid = doc.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "1fr 1fr";
        grid.style.gridTemplateRows = "1fr 1fr";
        grid.style.width = "100%";
        grid.style.height = "100%";
        const canvases: Record<string, HTMLCanvasElement> = {};
        for (const id of [...QUAD_PLANES.map((p) => p.id), QUAD_VOLUME_ID]) {
          const canvas = doc.createElement("canvas");
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.display = "block";
          grid.appendChild(canvas);
          canvases[id] = canvas;
        }
        container.appendChild(grid);
        this._quadGrid = { el: grid, canvases };
      }
      return this._quadGrid.canvases;
    }
    this._removeQuadGrid();
    if (!this._singleCanvas) {
      const doc = this._ownerDocument(container);
      const canvas = doc.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      container.appendChild(canvas);
      this._singleCanvas = canvas;
    }
    return { [MAIN_VIEW_ID]: this._singleCanvas };
  }

  private _removeSingleCanvas(): void {
    if (this._singleCanvas?.parentNode) {
      this._singleCanvas.parentNode.removeChild(this._singleCanvas);
    }
    this._singleCanvas = undefined;
  }

  private _removeQuadGrid(): void {
    if (this._quadGrid?.el.parentNode) {
      this._quadGrid.el.parentNode.removeChild(this._quadGrid.el);
    }
    this._quadGrid = undefined;
  }

  private _removeOwnedDom(): void {
    this._removeSingleCanvas();
    this._removeQuadGrid();
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a high-level Viewer on a selector, container, or canvas.
 *
 * - Selector / container: the Viewer creates and owns its canvas (a 2×2 grid
 *   of canvases in `"quad"` mode) inside the container.
 * - Canvas: framework ownership — the Viewer renders into it (`"quad"` mode
 *   is unavailable, it needs to own the layout).
 *
 * With `config.dataset`, the returned promise resolves only once the dataset
 * is open and ready; load failures reject with the actionable cause
 * (DX-M2 semantics). Without a dataset the viewer starts `idle` — call
 * `await viewer.open(config)`.
 */
export async function createViewer(
  element : string | HTMLElement | HTMLCanvasElement,
  config  : ViewerConfig = {},
): Promise<Viewer> {
  const viewer = new Viewer(resolveTarget(element), config);
  if (config.dataset) await viewer.open(config.dataset);
  return viewer;
}
