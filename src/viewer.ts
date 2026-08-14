/**
 * Viewer — the public viewing API in one module.
 *
 * Two layers live here:
 *
 * - `ViewerEngine` + `createViewerEngine` — the low-level orchestrator and
 *   state authority. Holds the global State, manages global GPU, Render and
 *   Views. Composed directly by advanced integrations (and internally by the
 *   facade and the 3D magnifier loupe).
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
  SourceDescriptor,
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
import { openDataset, type ResolvedDataset } from "./dataset";
import { controlRegistry, overlayRegistry } from "./registry";
import type {
  BaseControl,
  FlyControlOptions,
  OrbitControlOptions,
  PanZoomControlOptions,
} from "./control";
import type { BaseOverlay } from "./overlay";
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

    // Create Views
    for (const [name, vc] of Object.entries(config.views)) {
      this._views.set(name, createView(name, vc, this._layers, this));
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

    // Each setter takes a fresh deep-clone of state, mutates the matching
    // layer entry, and feeds it back through the normal commit path. This
    // avoids holding a stale reference to a removed/reordered entry and
    // means there is one and only one mutation site (`_commit`).
    const updateLayer = (mutate: (layer: LayerConfig) => void): void => {
      const next   = self.getState();
      const target = next.layers.find(l => l.id === id);
      if (!target) return;
      mutate(target);
      self._commit(next);
    };

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
        updateLayer((layer) => {
          layer.render = { ...(layer.render ?? {}), ...partial };
        });
      },
      setOptions(partial: Partial<TOptions>): void {
        updateLayer((layer) => {
          if (!layer.options) layer.options = {};
          for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
            const existing = layer.options[key];
            if (
              existing && typeof existing === "object" && !Array.isArray(existing) &&
              value    && typeof value    === "object" && !Array.isArray(value)
            ) {
              layer.options[key] = {
                ...(existing as Record<string, unknown>),
                ...(value    as Record<string, unknown>),
              };
            } else {
              layer.options[key] = value;
            }
          }
        });
      },
      setData(partial: Partial<Data>): void {
        updateLayer((layer) => {
          layer.data = { ...(layer.data ?? {}), ...partial } as Data;
        });
      },
    };
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
 * Visualization mode. `"auto"` resolves deterministically per dataset
 * capabilities (§16): z=1 → slice; z>1 → volume when the dataset reports 3D
 * support and the automatic tile-budget policy (DX-M4) yields a valid bounded
 * preview; otherwise slice, with volume still exposed in
 * `viewer.availableModes`.
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
 * Declarative tool set (DX-M6). Tools map to built-in overlays: crosshair →
 * `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier →
 * `"magnifier-2d"`/`"magnifier-3d"`. `true` enables with defaults, an options
 * bag enables with those options (same typed bag as the overlay), `false`/
 * absent disables. When `tools` is present it fully specifies the tool set.
 */
export interface ViewerToolsConfig {
  crosshair? : boolean | CrosshairOverlayOptions;
  ruler?     : boolean | RulerOverlayOptions;
  magnifier? : false | "2d" | "3d" | ViewerMagnifierOptions;
  roi?       : boolean | RoiSelectorOverlayOptions;
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
  /** Dataset source descriptor; resolved via `openDataset` (DX-M1). */
  source?        : SourceDescriptor;
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

/** Typed tool names and their option bags. */
export interface ViewerToolOptionsMap {
  crosshair : CrosshairOverlayOptions;
  ruler     : RulerOverlayOptions;
  magnifier : ViewerMagnifierOptions;
  roi       : RoiSelectorOverlayOptions;
}
export type ViewerToolName = keyof ViewerToolOptionsMap;

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
    else if (typeof v === "object" && v !== null) out[name] = { ...(v as object) } as never;
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
 * Capability-aware `"auto"` rule (§16): z=1 → slice; z>1 → volume when the
 * dataset supports 3D and the automatic tile-budget policy (DX-M4) yields a
 * valid bounded preview; otherwise slice.
 */
function resolveViewerMode(mode: ViewerMode, dataset: ResolvedDataset): ResolvedViewerMode {
  if (mode !== "auto") return mode;
  const caps = dataset.capabilities;
  if (caps.zDepth > 1 && caps.supports3D && caps.supportsVolumePreview) return "volume";
  return "slice";
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
  private _source?: SourceDescriptor;
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
  private _dataset?: ResolvedDataset;
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
    this._source = config.source;
    this._ready = Promise.resolve(this);
  }

  // === Accessors ===

  /** The resolved dataset, once open (decision 19.4 — `dataset` names the runtime object). */
  get dataset(): ResolvedDataset | undefined {
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

  /** Modes meaningful for the current dataset (§16: volume stays exposed for 3D data). */
  get availableModes(): ResolvedViewerMode[] {
    const caps = this._dataset?.capabilities;
    if (!caps) return [...RESOLVED_MODES];
    return caps.supports3D ? ["slice", "volume", "quad"] : ["slice"];
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
    if (this._source) config.source = this._source;
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
    // Round-trip through JSON: drops any callback a caller smuggled into a
    // tools bag and proves the schema is function-free.
    return JSON.parse(JSON.stringify(config)) as ViewerConfig;
  }

  // === Open / status (DX-M2) ===

  /**
   * Open (or replace) the dataset. Resolves with the dataset once ready;
   * rejects with the resolver's error as-is (`cause` chains preserved) when
   * the source fails, or with {@link ViewerSupersededError} when a newer
   * open/transition wins. Last-write-wins: a superseded open never clobbers
   * newer state.
   */
  async open(source: SourceDescriptor): Promise<ResolvedDataset> {
    this._assertUsable("open");
    const revision = ++this._revision;
    this._source = source;
    this._error = undefined;
    this._status = "loading";
    const op = this._runOpen(source, revision);
    this._track(op);
    return op;
  }

  private async _runOpen(source: SourceDescriptor, revision: number): Promise<ResolvedDataset> {
    let dataset: ResolvedDataset;
    try {
      dataset = await openDataset(source);
    } catch (err) {
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    this._assertCurrent(revision, "open");
    this._dataset = dataset;
    await this._rebuild(revision, resolveViewerMode(this._mode, dataset), undefined);
    return dataset;
  }

  // === Mode transitions (DX-L2) ===

  /**
   * Switch visualization mode. Synchronous to call, asynchronous to complete
   * — `await viewer.ready` observes completion. Transitions preserve the
   * physical focus (the camera target survives; the new mode's fit framing is
   * translated onto it) and channel intent (the channel model reapplies to
   * the new mode's layers). Last-write-wins: rapid flips settle on the final
   * mode.
   */
  set mode(value: ViewerMode) {
    this._assertUsable("mode");
    assertViewerMode(value);
    this._mode = value;
    if (!this._dataset) return; // intent recorded; resolved on open
    const mode = resolveViewerMode(value, this._dataset);
    if (mode === "quad" && this._target.kind === "canvas") {
      throw new Error(
        'viewer.mode = "quad" requires a container element (the Viewer lays out four ' +
        "canvases); pass a container to createViewer instead of a canvas",
      );
    }
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
      throw new Error("viewer.channel(): no dataset open — call viewer.open(source) first");
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

  // === Teardown ===

  /** Destroy the low-level instance, detach viewer-owned DOM, supersede in-flight work. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._revision; // supersede any in-flight open/transition
    this._teardownEngine();
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
    }

    const activeViewId = mode === "quad" ? QUAD_PLANES[0].id : MAIN_VIEW_ID;
    engine.setActiveView(activeViewId);

    // Slice layers default to the center slice; a preserved focus must show
    // the slice AT the focus (DX-L2 focus preservation covers what is shown,
    // not just where the camera looks).
    if (focus) this._syncSliceLayers(mode, focus);

    // Surface any layer load failure with DX-M2 semantics. Layers carry the
    // dataset's explicit pyramid/fetch, so they report ready immediately —
    // this is the guard that keeps `open`'s "resolves ready" contract honest.
    const view = engine.view(activeViewId);
    for (const id of this._layerIdsForMode(mode)) {
      const status = view.getLayerStatus(id);
      if (status?.status === "error") {
        const err = status.error ?? new Error(`Layer "${id}" failed to load`);
        if (this._isCurrent(revision)) {
          this._error = err;
          this._status = "error";
        }
        throw err;
      }
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

  // === Translation (§15.5) ===

  private _requireDataset(): ResolvedDataset {
    if (!this._dataset) throw new Error("No dataset open — call viewer.open(source) first");
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

  /** Layer IDs for every channel across the mode's views (`<prefix>-c<index>`). */
  private _layerIdsForMode(mode: ResolvedViewerMode): string[] {
    const dataset = this._requireDataset();
    const ids: string[] = [];
    for (const prefix of layerPrefixesForMode(mode)) {
      for (const channel of dataset.channels) ids.push(`${prefix}-c${channel.index}`);
    }
    return ids;
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
    const spacing = dataset.physical.spatial.spacing ?? [1, 1, 1];
    const origin = dataset.physical.spatial.origin ?? [0, 0, 0];
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
    const physical = this._requireDataset().physical;
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
      ...dataset.physical,
      channels: { names: channels.map((c) => c.label) },
    };
    const layers: LayerConfig[] = [];
    const views: Record<string, ViewConfig> = {};

    const pushLayers = (prefix: string, kind: ViewKind, axes?: readonly string[]): string[] => {
      const ids: string[] = [];
      for (const channel of channels) {
        const id = `${prefix}-c${channel.index}`;
        const render: Render = {
          visible        : channel.visible,
          color          : channel.color,
          contrastLimits : [...channel.contrast] as [number, number],
          // One layer per channel composites fluorescence-style: additive is
          // the multichannel default for viewer-generated image layers.
          blending       : "additive",
          ...(kind === "volume" ? { volumeProjection: this._projection } : {}),
        };
        layers.push({
          id,
          type : kind,
          // The dataset's canonical descriptor stays on the layer for
          // provenance/serialization; the explicit pyramid/fetch win at
          // runtime (Data precedence), so no per-layer re-resolution happens.
          data    : {
            source: dataset.source,
            pyramid: dataset.pyramid,
            fetch: dataset.fetch,
            ...(transform !== undefined ? { transform: [...transform] } : {}),
          },
          render,
          options : {
            ...(axes ? { axes: [...axes] } : {}),
            selection: { ...dataset.defaultSelection, c: channel.index },
          },
        });
        ids.push(id);
      }
      return ids;
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
 * With `config.source`, the returned promise resolves only once the dataset
 * is open and ready; resolver failures reject with the actionable cause
 * (DX-M2 semantics). Without a source the viewer starts `idle` — call
 * `await viewer.open(source)`.
 */
export async function createViewer(
  element : string | HTMLElement | HTMLCanvasElement,
  config  : ViewerConfig = {},
): Promise<Viewer> {
  const viewer = new Viewer(resolveTarget(element), config);
  if (config.source) await viewer.open(config.source);
  return viewer;
}
