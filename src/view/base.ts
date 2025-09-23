/**
 * Views Base Module
 *
 * BaseView — abstract base for all views.
 * Handles GPU init, layer management, overlays, events, canvas resize,
 * shared scene uniforms, and canonical layer ordering.
 *
 * Per-view rendering machinery (`ImagePipeline` + `createView` factory)
 * lives in `./runtime/`.
 */

import { mat4, type Mat4 } from "wgpu-matrix";
import type {
  State,
  Action,
  ID,
  LayerConfig,
  Vec3,
} from "../types";
import type { Galavi } from "../main";
import {
  normalizeWheel,
  normalizeDrag,
} from "../utils";
import type { BaseControl } from "../control";
import { BaseOverlay } from "../overlay";
import { BaseLayer } from "../layer";

// ============================================================================
// SCENE — projection uniforms shared by all views
// ============================================================================

/**
 * Scene Uniform Layout (144 bytes / 36 floats):
 * ┌─────────────────────────────────────────────────┐
 * │ worldToClip  : mat4x4f  (16 floats, offset 0)   │
 * │ clipToWorld  : mat4x4f  (16 floats, offset 64)  │
 * │ eye          : vec4f    (4  floats, offset 128) │
 * └─────────────────────────────────────────────────┘
 */
export const SCENE_UNIFORM_SIZE = 144;

/** Scene parameters for GPU projection */
export interface Scene {
  position  : Vec3;
  target    : Vec3;
  up        : Vec3;
  fov       : number;
  near      : number;
  far       : number;
}

// ============================================================================
// LAYER ORDERING
// ============================================================================

/** Opaque → translucent → additive/minimum render order. */
const BLEND_ORDER: Record<string, number> = {
  opaque     : 0,
  translucent: 1,
  additive   : 2,
  minimum    : 2,
};

export function sortedByBlending(layers: readonly BaseLayer[]): BaseLayer[] {
  return [...layers].sort(
    (a, b) => (BLEND_ORDER[a.blending] ?? 1) - (BLEND_ORDER[b.blending] ?? 1),
  );
}

// ============================================================================
// BASE VIEW
// ============================================================================

/**
 * Static contract for view classes registered via `viewRegistry`. Each
 * concrete view declares its `viewType` string statically; the registry
 * instantiates via `new cls(id)` and the base class reads the type off the
 * subclass.
 */
export interface ViewClass {
  readonly viewType: string;
  new (id: ID): BaseView;
}

export abstract class BaseView {
  readonly id: ID;
  readonly viewType: string;

  canvas!: HTMLCanvasElement;
  protected device!: GPUDevice;
  protected context!: GPUCanvasContext;
  private canvasFormat!: GPUTextureFormat;
  protected galavi?: Galavi;
  protected layerEntries: BaseLayer[] = [];
  protected overlays: BaseOverlay[] = [];
  private localControls: BaseControl[] = [];

  private isInitialized = false;

  private eventHandlers = new Map<string, EventListener>();
  private boundCanvas?: HTMLCanvasElement;
  private eventsEnabled = false;

  /** Whether this view is currently active (managed by Explorer) */
  isActive = false;

  private readonly overlayBinding = {
    getViewType: () => this.viewType,
    getLayerIds: () => this.layerEntries.map((layer) => layer.id),
    getCanvas: () => this.canvas,
    isActive: () => this.isActive,
  };

  constructor(id: ID) {
    this.id = id;
    this.viewType = (this.constructor as ViewClass).viewType;
  }

  // === Lifecycle ===

  /**
   * Override to create device-scoped GPU resources (pipelines, buffers, bind
   * groups, samplers). Called at most once per view instance, before the first
   * `mount()` returns.
   *
   * Format-bound resources (render pipelines targeting the swap-chain format)
   * may be created here, but subclasses MUST also handle
   * {@link onCanvasFormatChanged} to invalidate them when the preferred
   * canvas format changes between mounts (e.g. swapping to an HDR display).
   */
  protected abstract initGPUResources(): Promise<void>;
  /**
   * Hook called by `mount()` when re-mounting on a different canvas whose
   * preferred format differs from the previously-bound canvas. Default no-op;
   * override to invalidate format-bound render pipelines (e.g. by calling
   * `pipeline.markDirty()` on any owned `ImagePipeline`).
   */
  protected onCanvasFormatChanged(): void {}
  protected onDestroy(): void {}

  /**
   * Override to render all layer entries.
   * Called on each state change.
   */
  protected abstract renderFrame(state: State): void;
  render(state: State): void {
    if (!this.boundCanvas) return;
    this.resizeCanvasToDisplaySize();

    // Apply config + per-frame layer hooks (one pass).
    // Each layer consumes its own LayerConfig, then `prepareFrame` lets layers
    // update state that depends on the camera or sibling layers (e.g. shapes
    // recomputing slice entries against a sibling surface).
    const layerDescByName = new Map(state.layers.map((l) => [l.id, l]));
    const siblings = new Map<string, { desc: LayerConfig; layer: BaseLayer }>();
    for (const layer of this.layerEntries) {
      const desc = layerDescByName.get(layer.id);
      if (desc) {
        layer.applyConfig(desc, state.physical);
        siblings.set(layer.id, { desc, layer });
      }
    }
    for (const layer of this.layerEntries) {
      layer.prepareFrame(state, siblings);
    }

    this.renderFrame(state);
    for (const overlay of this.overlays) {
      overlay.render(state);
    }
  }

  setDevice(device: GPUDevice): void {
    if (this.device === device) return;
    const wasUnset = !this.device;
    this.device = device;
    if (wasUnset) {
      for (const layer of this.layerEntries) {
        this.initLayerGpu(layer);
      }
    }
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    if (!this.device) {
      throw new Error("GPU device not set. Call setDevice() before mount().");
    }

    // Re-mount onto a different canvas: tear down the previous binding first
    // so overlays detach from the old parent and event handlers don't leak.
    if (this.boundCanvas && this.boundCanvas !== canvas) {
      this.unmount();
    }

    // Detach stale event handlers from any previous canvas before switching
    if (this.eventsEnabled) {
      this.detachEventHandlers();
      this.eventsEnabled = false;
    }

    this.canvas = canvas;
    this.boundCanvas = canvas;

    this.context = canvas.getContext("webgpu") as GPUCanvasContext;
    const newFormat = navigator.gpu.getPreferredCanvasFormat();
    const formatChanged = this.isInitialized && this.canvasFormat !== newFormat;
    this.canvasFormat = newFormat;
    this.resizeCanvasToDisplaySize();
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: "premultiplied",
    });

    if (!this.isInitialized) {
      await this.initGPUResources();
      this.isInitialized = true;
    } else if (formatChanged) {
      // Format-bound pipelines built against the previous canvas format must
      // be rebuilt against the new one.
      this.onCanvasFormatChanged();
    }

    // Mount overlays as DOM layers above the canvas
    const parent = canvas.parentElement as HTMLElement | null;
    if (parent) {
      for (const overlay of this.overlays) {
        try {
          overlay.mount(parent);
        } catch (e) {
          console.warn("Overlay mount failed", e);
        }
      }
    }
  }

  unmount(): void {
    this.disableEvents();
    this.context?.unconfigure();
    for (const overlay of this.overlays) {
      try {
        overlay.unmount();
      } catch (e) {
        console.warn("Overlay unmount failed", e);
      }
    }
    this.boundCanvas = undefined;
  }

  destroy(): void {
    this.unmount();
    try {
      this.onDestroy();
    } catch (e) {
      console.warn("Error cleaning up GPU resources:", e);
    }
    this.isInitialized = false;
  }

  // === Layer Management ===

  /**
   * Wire a layer's render-request channel and (if device is ready) initialize
   * its async data. Tile residency is owned by the view-side ImagePipeline,
   * so layers no longer touch the GPU during attach.
   */
  private wireLayer(layer: BaseLayer): void {
    layer.attach({ requestRender: () => this.galavi?.requestRender() });
    if (this.device) this.initLayerGpu(layer);
  }

  private initLayerGpu(layer: BaseLayer): void {
    if (!this.device) return;
    void layer.initAsync().then(() => {
      this.onLayersChanged();
      this.galavi?.requestRender();
    });
  }

  /**
   * Override to rebuild pipelines when layers change.
   */
  protected abstract onLayersChanged(): void;

  addLayer(layer: BaseLayer): void {
    if (!this.layerEntries.includes(layer)) {
      this.layerEntries.push(layer);
      this.wireLayer(layer);
      if (this.device) this.onLayersChanged();
    }
  }

  removeLayer(layer: BaseLayer): void {
    const idx = this.layerEntries.indexOf(layer);
    if (idx >= 0) {
      this.layerEntries.splice(idx, 1);
      layer.detach();
      this.onLayersChanged();
    }
  }

  setLayers(entries: BaseLayer[]): void {
    for (const old of this.layerEntries) {
      if (!entries.includes(old)) old.detach();
    }
    this.layerEntries = [...entries];
    for (const layer of this.layerEntries) {
      this.wireLayer(layer);
    }
    if (this.device) this.onLayersChanged();
  }

  getLayers(): readonly BaseLayer[] {
    return this.layerEntries;
  }

  // === Overlay management ===

  addOverlay(overlay: BaseOverlay): void {
    if (this.overlays.includes(overlay)) return;
    overlay.bindView(this.overlayBinding);
    this.overlays.push(overlay);
  }

  removeOverlay(overlay: BaseOverlay): void {
    const i = this.overlays.indexOf(overlay);
    if (i >= 0) {
      overlay.unmount();
      this.overlays.splice(i, 1);
    }
  }

  setOverlays(list: BaseOverlay[]): void {
    for (const overlay of this.overlays) {
      if (!list.includes(overlay)) overlay.unmount();
    }
    this.overlays = [];
    for (const overlay of list) {
      this.addOverlay(overlay);
    }
  }

  getOverlays(): readonly BaseOverlay[] {
    return this.overlays;
  }

  // === Control Management ===

  /** Set the view's local control chain. */
  setControls(controls: BaseControl[]): void {
    this.localControls = controls;
  }

  /** Get the view's local controls. */
  getControls(): readonly BaseControl[] {
    return this.localControls;
  }

  // === Scene Utilities ===

  /** Compute world-space bounds of all layer entries */
  protected getSceneBounds(): {
    min: Vec3;
    max: Vec3;
    size: Vec3;
    center: Vec3;
    maxExtent: number;
  } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const entry of this.layerEntries) {
      const aabb = entry.getWorldAABB();
      if (!aabb) continue;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], aabb.min[i]);
        max[i] = Math.max(max[i], aabb.max[i]);
      }
    }
    if (!isFinite(min[0])) {
      min[0] = min[1] = min[2] = 0;
      max[0] = max[1] = max[2] = 1;
    }
    const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const center: Vec3 = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const maxExtent = Math.max(size[0], size[1], size[2], 1e-6);
    return { min, max, size, center, maxExtent };
  }

  /** Transform a 3D point by a 4×4 column-major matrix */
  protected transformPoint(matrix: Float32Array, point: Vec3): Vec3 {
    const x = point[0],
      y = point[1],
      z = point[2];
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
  }

  /**
   * Create orthographic scene uniform data (2D views).
   * View = translation by -target; projection = ortho with Y-flip.
   */
  protected createOrthographicUniforms(
    scene: Scene,
    aspect: number,
  ): Float32Array {
    const view = mat4.translation([
      -scene.target[0],
      -scene.target[1],
      0,
    ]) as Mat4;
    const halfY = scene.fov;
    const halfX = halfY * aspect;
    const proj = mat4.ortho(
      -halfX,
      halfX,
      halfY,
      -halfY,
      scene.near,
      scene.far,
    ) as Mat4;
    return this._packSceneUniforms(view, proj, scene);
  }

  /**
   * Create perspective scene uniform data (3D views).
   * View = lookAt; projection = perspective with Y-flip.
   */
  protected createPerspectiveUniforms(
    scene: Scene,
    aspect: number,
  ): Float32Array {
    const view = mat4.lookAt(scene.position, scene.target, scene.up) as Mat4;
    const proj = mat4.perspective(
      scene.fov,
      aspect,
      scene.near,
      scene.far,
    ) as Mat4;
    proj[5] = -proj[5]; // Flip Y for image-coordinate convention
    return this._packSceneUniforms(view, proj, scene);
  }

  private _packSceneUniforms(
    view: Mat4,
    proj: Mat4,
    scene: Scene,
  ): Float32Array {
    const worldToClip = mat4.multiply(proj, view) as Mat4;
    const clipToWorld = mat4.inverse(worldToClip) as Mat4;
    const data = new Float32Array(36);
    data.set(worldToClip, 0);
    data.set(clipToWorld, 16);
    data.set([...scene.position, 1.0], 32);
    return data;
  }

  private resizeCanvasToDisplaySize(): void {
    if (!this.canvas || !this.context) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.configure({
        device: this.device,
        format: this.canvasFormat,
        alphaMode: "premultiplied",
      });
    }
  }

  /**
   * Post-control hook for views to clamp state (e.g. LOD safety caps).
   *
   * The view-level LOD clamp is the canonical second tier of the three-tier LOD
   * design: control expresses semantic intent, view caps to
   * canvas / pyramid bounds, layer applies a final per-data backstop. Concrete
   * views typically delegate to `clampLodLevel`.
   */
  protected clampState(state: State): State {
    return state;
  }

  /**
   * Canonical view-tier LOD clamp — narrows a manual LOD level to the
   * intersection of every layer's pyramid range. Returns the same state
   * reference unmodified when no clamp is needed (mode != manual, no tiled
   * layers, or value already in range), preserving `forward()`'s reference
   * equality short-circuit.
   */
  protected clampLodLevel(state: State): State {
    if (state.exploration.lod.mode !== "manual") return state;
    let finest    = 0;
    let coarsest  = Infinity;
    for (const layer of this.layerEntries) {
      if (layer.levelRange) {
        finest    = Math.max(finest, layer.levelRange[0]);
        coarsest  = Math.min(coarsest, layer.levelRange[1]);
      }
    }
    if (coarsest === Infinity) return state;
    const current = state.exploration.lod.level;
    const clamped = Math.max(finest, Math.min(coarsest, current));
    if (clamped === current) return state;
    return {
      ...state,
      exploration: {
        ...state.exploration,
        lod: { ...state.exploration.lod, level: clamped },
      },
    };
  }

  /** Bind this view to its owning Galavi instance (used for `requestRender`). */
  setOwner(galavi: Galavi): void {
    this.galavi = galavi;
  }

  // === Event Handling ===

  private _dragging = false;
  private _lastX = 0;
  private _lastY = 0;
  private _pressedKeys = new Set<string>();
  private _keyTickId?: number;
  private _lastKeyTickTime = 0;

  /** Register standard DOM event handlers on the canvas. Called after mount. */
  protected registerDOMEvents(): void {
    this.on("mousedown", this._handleMouseDown.bind(this));
    this.on("wheel", this._handleWheel.bind(this));
    this.on("dblclick", this._handleDblClick.bind(this));
    this.on("keydown", this._handleKeyDown.bind(this));
    this.on("keyup", this._handleKeyUp.bind(this));

    // Make canvas focusable for keyboard events
    if (this.canvas && !this.canvas.hasAttribute("tabindex")) {
      this.canvas.setAttribute("tabindex", "0");
      this.canvas.style.outline = "none";
    }
  }

  private _handleMouseDown(e: Event): void {
    const event = e as MouseEvent;
    this._dragging = true;
    this._lastX = event.clientX;
    this._lastY = event.clientY;

    const handleMouseMove = (e: MouseEvent) => {
      if (!this._dragging) return;

      const rawDx = e.clientX - this._lastX;
      const rawDy = e.clientY - this._lastY;
      const { dx, dy } = normalizeDrag(
        rawDx,
        rawDy,
        this.canvas.clientWidth,
        this.canvas.clientHeight,
      );
      const aspect =
        this.canvas.clientHeight > 0
          ? this.canvas.clientWidth / this.canvas.clientHeight
          : 1;

      this.forward({
        type: "mouse:drag",
        payload: { dx, dy, aspect, axisMap: this.getAxisMap() },
      });

      this._lastX = e.clientX;
      this._lastY = e.clientY;
    };

    const handleMouseUp = () => {
      this._dragging = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  private _handleWheel(e: Event): void {
    const event = e as WheelEvent;
    event.preventDefault();

    const delta = normalizeWheel(event);
    const rect = this.canvas.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    const aspect = rect.height > 0 ? rect.width / rect.height : 1;

    this.forward({
      type: "mouse:wheel",
      payload: {
        delta,
        cursorX: nx,
        cursorY: ny,
        aspect,
        axisMap: this.getAxisMap(),
      },
    });
  }

  private _handleDblClick(e: Event): void {
    const event = e as MouseEvent;
    const rect = this.canvas.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    const aspect = rect.height > 0 ? rect.width / rect.height : 1;

    this.forward({
      type: "mouse:dblclick",
      payload: {
        x: nx,
        y: ny,
        aspect,
        axisMap: this.getAxisMap(),
        viewId: this.id,
      },
    });
  }

  private _handleKeyDown(e: Event): void {
    const event = e as KeyboardEvent;
    if (event.repeat) return;

    this._pressedKeys.add(event.code);

    this.forward({
      type: "key:down",
      payload: {
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
      },
    });

    // Start RAF ticker for key:held if not running
    if (this._keyTickId === undefined) {
      this._lastKeyTickTime = performance.now();
      this._keyTick();
    }
  }

  private _handleKeyUp(e: Event): void {
    const event = e as KeyboardEvent;
    this._pressedKeys.delete(event.code);

    if (this._pressedKeys.size === 0 && this._keyTickId !== undefined) {
      cancelAnimationFrame(this._keyTickId);
      this._keyTickId = undefined;
    }
  }

  private _keyTick(): void {
    if (this._pressedKeys.size === 0) {
      this._keyTickId = undefined;
      return;
    }

    const now = performance.now();
    const dt = (now - this._lastKeyTickTime) / 1000; // seconds
    this._lastKeyTickTime = now;

    this.forward({
      type: "key:held",
      payload: { codes: [...this._pressedKeys], dt },
    });

    this._keyTickId = requestAnimationFrame(() => this._keyTick());
  }

  enableEvents(): void {
    if (this.eventsEnabled) return;
    this.attachEventHandlers();
    this.eventsEnabled = true;
  }

  disableEvents(): void {
    if (!this.eventsEnabled) return;
    this.detachEventHandlers();
    this._pressedKeys.clear();
    if (this._keyTickId !== undefined) {
      cancelAnimationFrame(this._keyTickId);
      this._keyTickId = undefined;
    }
    this.eventsEnabled = false;
  }

  get hasEventsEnabled(): boolean {
    return this.eventsEnabled;
  }

  protected on(event: string, handler: EventListener): void {
    this.eventHandlers.set(event, handler);
  }

  private attachEventHandlers(): void {
    if (!this.boundCanvas) return;
    for (const [event, handler] of this.eventHandlers) {
      this.boundCanvas.addEventListener(event, handler);
    }
  }

  private detachEventHandlers(): void {
    if (!this.boundCanvas) return;
    for (const [event, handler] of this.eventHandlers) {
      this.boundCanvas.removeEventListener(event, handler);
    }
  }

  forward(action: Action): void {
    if (!this.galavi || this.localControls.length === 0) return;

    const initial = this.galavi.getState();
    const activeNavMode = initial.exploration.camera.navMode;
    let state = initial;

    for (const ctrl of this.localControls) {
      // Skip nav controls that don't match the active navigation mode
      if (ctrl.navMode && ctrl.navMode !== activeNavMode) continue;
      state = ctrl.handle(action, state);
    }

    // Pure-reducer no-op: every control returned the same state reference.
    // Skip commit + render — nothing changed.
    if (state === initial) return;

    state = this.clampState(state);
    this.galavi.setState(state);
  }

  // === Getters ===

  get gpuDevice(): GPUDevice {
    return this.device;
  }
  get gpuContext(): GPUCanvasContext {
    return this.context;
  }
  get canvasElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Return the axis permutation for this view, or undefined for 3D views. */
  protected getAxisMap(): [number, number, number] | undefined {
    return undefined;
  }
}

