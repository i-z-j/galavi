/**
 * Galavi Main Class
 *
 * Galavi class is the orchestrator and state authority.
 * Holds the global State, manages global GPU, Render and Views.
 */

import type {
  ID,
  Vec3,
  GalaviConfig,
  State,
  ViewConfig,
  PhysicalSpace,
  LayerConfig,
  Exploration,
  Camera,
  Render,
  Data,
  ViewResolution,
} from "./types";
import {
  AUTO_ROTATE_SPEED_DEG_PER_SEC,
  DEFAULT_CAMERA_NAV_MODE,
  DEFAULT_CAMERA_PROJ_MODE,
  DEFAULT_EXPLORATION,
  DEFAULT_STATE,
} from "./defaults";
import {
  BaseView,
} from "./view";
import { createView, type ViewRuntime } from "./view/runtime";
import type { BaseLayer } from "./layer";
import { resolveTheme, type GalaviTheme } from "./overlay/theme";
import { cameraDistance, cameraAngles, computePosition, computeForward } from "./utils";
import { vec3 } from "wgpu-matrix";

// ============================================================================
// GALAVI CLASS
// ============================================================================

type LayerAccessor = {
  readonly config: LayerConfig;
  setRender(partial: Partial<Render>): void;
  setOptions(partial: Record<string, unknown>): void;
  setData(partial: Partial<Data>): void;
};

type ViewAccessor = {
  setOverlayOptions(overlayType: string, opts: Record<string, unknown>): void;
  getLayer(id: ID): BaseLayer | undefined;
  getCurrentLevel(layerId: ID): number | undefined;
  getResolution(layerId: ID): ViewResolution | undefined;
  readonly config: ViewConfig;
  readonly base: BaseView;
};

export class Galavi {
  /** Resolved overlay UI theme (`GalaviConfig.theme` over the FUI defaults). */
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

  constructor(config: GalaviConfig) {
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
        console.error(`[Galavi] view "${vr.view.id}" render failed:`, e);
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
  layer(id: ID): LayerAccessor | undefined {
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
      get config(): LayerConfig {
        const entry = self._layers.find(l => l.id === id)!;
        return {
          ...entry,
          render  : entry.render  ? { ...entry.render }  : undefined,
          options : entry.options ? { ...entry.options } : undefined,
          data    : entry.data    ? { ...entry.data }    : undefined,
        };
      },
      setRender(partial: Partial<Render>): void {
        updateLayer((layer) => {
          layer.render = { ...(layer.render ?? {}), ...partial };
        });
      },
      setOptions(partial: Record<string, unknown>): void {
        updateLayer((layer) => {
          if (!layer.options) layer.options = {};
          for (const [key, value] of Object.entries(partial)) {
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
      },
      getLayer: (id: ID) => vr.layers.get(id),
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
    // Release the GPU device itself — destroyed Galavi instances must not
    // keep counting against the browser's per-page WebGPU device limit.
    this._device?.destroy();
    this._device = undefined;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a Galavi instance from a GalaviConfig.
 * Initialises GPU and mounts views that have a canvas specified.
 */
export async function createGalavi(config: GalaviConfig): Promise<Galavi> {
  const galavi = new Galavi(config);

  const canvasMap: Record<string, HTMLCanvasElement> = {};
  for (const [name, vc] of Object.entries(config.views)) {
    if (vc.canvas) canvasMap[name] = vc.canvas;
  }

  if (Object.keys(canvasMap).length > 0) {
    await galavi.mountAll(canvasMap);
  }

  return galavi;
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
