/**
 * Views Base Module
 *
 * BaseView — abstract base for all views.
 * Handles GPU init, layer management, overlays, events, canvas resize,
 * shared scene uniforms, canonical layer ordering, and shared frame
 * helpers (camera buffer, depth attachment, render-pass scaffolding).
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
  Vec2,
  Vec3,
  ViewResolution,
} from "../types";
import type { ViewerEngine } from "../viewer";
import {
  normalizeWheel,
  normalizeDrag,
  type AxisMap,
} from "../utils";
import { DEPTH_FORMAT } from "../defaults";
import type { BaseControl } from "../control";
import { BaseOverlay } from "../overlay";
import { DEFAULT_THEME } from "../overlay/theme";
import { BaseLayer, type LayerLoadState } from "../layer";
import type { ImagePipeline } from "./runtime";

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
  protected engine?: ViewerEngine;
  protected layerEntries: BaseLayer[] = [];
  protected overlays: BaseOverlay[] = [];
  private localControls: BaseControl[] = [];

  /**
   * Per-layer raster machinery, assigned by subclasses in initGPUResources.
   * Base hooks optional-chain it because they can fire before init.
   */
  protected pipeline!: ImagePipeline;
  private depthTexture?: GPUTexture;

  private isInitialized = false;

  private eventHandlers = new Map<string, EventListener>();
  private boundCanvas?: HTMLCanvasElement;
  private eventsEnabled = false;
  private resizeObserver?: ResizeObserver;

  /**
   * Whether the view observes canvas content-box resizes and re-renders on
   * change (mirrors `ViewConfig.autoResize`, default true). Wired by the view
   * factory; set before `mount()` to take effect.
   */
  autoResize = true;

  /** Whether this view is currently active (managed by Explorer) */
  isActive = false;

  private readonly overlayBinding = {
    getViewType: () => this.viewType,
    getLayerIds: () => this.layerEntries.map((layer) => layer.id),
    getCanvas: () => this.canvas,
    isActive: () => this.isActive,
    getAxisMap: () => this.getAxisMap(),
    getTheme: () => this.engine?.theme ?? DEFAULT_THEME,
    getOwner: () => this.engine,
    projectPhysicalToScreen: (position: Vec3) => this.projectPhysicalToScreen(position),
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
   * preferred format differs from the previously-bound canvas. Default
   * invalidates the shared ImagePipeline; override to invalidate any other
   * format-bound render pipelines the subclass owns.
   */
  protected onCanvasFormatChanged(): void {
    this.pipeline?.markDirty();
  }
  /** Hook for canvas identity or pixel-size changes that affect view resolution. */
  protected onViewportChanged(): void {
    this.pipeline?.resetResolutionSelection();
  }
  protected onDestroy(): void {}
  protected projectPhysicalToScreen(_position: Vec3): Vec2 | null | undefined {
    return undefined;
  }

  /**
   * Override to render all layer entries.
   * Called on each state change.
   */
  protected abstract renderFrame(state: State): void;
  render(state: State): void {
    if (!this.boundCanvas) return;
    if (this.resizeCanvasToDisplaySize()) this.onViewportChanged();

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
    this.device = device;
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    if (!this.device) {
      throw new Error("GPU device not set. Call setDevice() before mount().");
    }

    const canvasChanged = this.boundCanvas !== canvas;

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
    } else {
      if (formatChanged) {
        // Format-bound pipelines built against the previous canvas format must
        // be rebuilt against the new one.
        this.onCanvasFormatChanged();
      }
      if (canvasChanged) this.onViewportChanged();
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

    this.observeCanvasResize(canvas);
  }

  unmount(): void {
    this.unobserveCanvasResize();
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
    for (const layer of [...this.readinessWaiters.keys()]) {
      this.failReadinessWaiters(layer, new Error(`View "${this.id}" destroyed`));
    }
    try {
      this.onDestroy();
    } catch (e) {
      console.warn("Error cleaning up GPU resources:", e);
    }
    this.pipeline?.destroy();
    this.depthTexture?.destroy();
    this.depthTexture  = undefined;
    this.isInitialized = false;
  }

  // === Layer readiness ===

  private readinessWaiters = new Map<BaseLayer, Set<{
    resolve: (layer: BaseLayer) => void;
    reject: (err: unknown) => void;
  }>>();

  /**
   * Resolve once `layer` reports `isReady`.
   *
   * Semantics:
   * - Resolves immediately when the layer is already ready.
   * - Otherwise pends until the layer signals through its render-request
   *   channel (async tile/geometry work, or the engine's tracked-load
   *   fan-out, ARCH-1) while `isReady` holds. If the layer's source
   *   reloads before resolution — flipping `isReady` back to false — the wait
   *   simply continues until the layer becomes ready for the new data.
   * - A settled promise is unaffected by later source reloads; callers that
   *   change a layer's source should call `whenLayerReady` again.
   * - Rejects with the layer's recorded load error when its source fails
   *   (DX-M2 — e.g. unknown source type, unsupported metadata, network/CORS
   *   failure): pending waiters reject when the failure is signaled, and
   *   calls made while `loadStatus` is `"error"` reject immediately.
   * - Rejects with `signal.reason` when the passed AbortSignal aborts, when
   *   the layer is removed from the view, or when the view is destroyed.
   *
   * Abort/failure precedence: an abort settles only its own waiter — an
   * aborted waiter is removed, so a later failure cannot reject it (abort
   * wins over a late failure). A call made with an already-aborted signal
   * rejects with the abort reason even when the layer is already in error
   * (the abort check runs first).
   */
  whenLayerReady(layer: BaseLayer, signal?: AbortSignal): Promise<BaseLayer> {
    if (signal?.aborted) return Promise.reject(signal.reason as unknown);
    if (layer.loadStatus === "error") {
      return Promise.reject(
        layer.loadError ?? new Error(`Layer "${layer.id}" failed to load`),
      );
    }
    if (layer.isReady) return Promise.resolve(layer);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      let waiters = this.readinessWaiters.get(layer);
      if (!waiters) {
        waiters = new Set();
        this.readinessWaiters.set(layer, waiters);
      }
      waiters.add(waiter);
      signal?.addEventListener("abort", () => {
        waiters.delete(waiter);
        reject(signal.reason as unknown);
      }, { once: true });
    });
  }

  /**
   * Settle pending readiness waiters after a layer signal: resolve when the
   * layer is ready, reject with the recorded load error when it failed.
   *
   * ARCH-1: called by the owning ViewerEngine's fan-out — the layer's
   * render-request channel is attached once at the engine and each signal
   * reaches every referencing view through this method.
   */
  notifyLayerSignal(layer: BaseLayer): void {
    const waiters = this.readinessWaiters.get(layer);
    if (!waiters) return;
    if (layer.loadStatus === "error") {
      this.readinessWaiters.delete(layer);
      const err = layer.loadError ?? new Error(`Layer "${layer.id}" failed to load`);
      for (const waiter of waiters) waiter.reject(err);
      return;
    }
    if (!layer.isReady) return;
    this.readinessWaiters.delete(layer);
    for (const waiter of waiters) waiter.resolve(layer);
  }

  /**
   * Engine fan-out entry (ARCH-1): the shared runtime layer's tracked async
   * load settled (successfully, or with a recorded `loadError`). Rebuilds
   * this view's per-layer GPU pipelines (new geometry/textures become
   * drawable) and settles this view's readiness waiters. No-op when the
   * layer is not part of this view.
   */
  handleLayerLoadSettled(layer: BaseLayer): void {
    if (!this.layerEntries.includes(layer)) return;
    this.onLayersChanged();
    this.notifyLayerSignal(layer);
  }

  /** Reject pending readiness waiters (layer removed, view destroyed). */
  private failReadinessWaiters(layer: BaseLayer, err: unknown): void {
    const waiters = this.readinessWaiters.get(layer);
    if (!waiters) return;
    this.readinessWaiters.delete(layer);
    for (const waiter of waiters) waiter.reject(err);
  }

  // === Layer Management ===

  /**
   * Layer instances are owned by the ViewerEngine (ARCH-1): one runtime
   * instance per state-layer ID, created at engine construction and shared
   * by every referencing view. View membership management below never wires
   * or unwires the layer's render-request channel — the engine attaches it
   * once and fans signals out to every referencing view.
   */

  /**
   * Called when the layer set changes; default invalidates the shared
   * ImagePipeline so the next frame re-syncs its per-layer pipelines.
   */
  protected onLayersChanged(): void {
    this.pipeline?.markDirty();
  }

  addLayer(layer: BaseLayer): void {
    if (!this.layerEntries.includes(layer)) {
      this.layerEntries.push(layer);
      if (this.device) this.onLayersChanged();
    }
  }

  removeLayer(layer: BaseLayer): void {
    const idx = this.layerEntries.indexOf(layer);
    if (idx >= 0) {
      this.layerEntries.splice(idx, 1);
      this.failReadinessWaiters(
        layer,
        new Error(`Layer "${layer.id}" removed from view "${this.id}"`),
      );
      this.onLayersChanged();
    }
  }

  setLayers(entries: BaseLayer[]): void {
    for (const old of this.layerEntries) {
      if (!entries.includes(old)) {
        this.failReadinessWaiters(
          old,
          new Error(`Layer "${old.id}" removed from view "${this.id}"`),
        );
      }
    }
    this.layerEntries = [...entries];
    if (this.device) this.onLayersChanged();
  }

  getLayers(): readonly BaseLayer[] {
    return this.layerEntries;
  }

  /** View-local pyramid level selected for a tiled layer, if available. */
  getCurrentLevel(layerId: ID): number | undefined {
    return this.pipeline?.getCurrentLevel(layerId);
  }

  /**
   * Snapshot of a layer's load state (DX-M2): `idle` / `loading` / `ready` /
   * `error`, with the recorded error when failed. Poll-based counterpart of
   * `whenLayerReady` — no subscription needed. Returns `undefined` for
   * unknown layer IDs.
   */
  getLayerStatus(layerId: ID): LayerLoadState | undefined {
    const layer = this.layerEntries.find((entry) => entry.id === layerId);
    if (!layer) return undefined;
    const status = layer.loadStatus;
    return status === "error" ? { status, error: layer.loadError } : { status };
  }

  /** View-local image resolution for a tiled layer, if available. */
  getResolution(layerId: ID): ViewResolution | undefined {
    return this.pipeline?.getResolution(layerId);
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

  /** Create the per-view scene/camera uniform buffer. */
  protected createCameraBuffer(label: string): GPUBuffer {
    return this.device.createBuffer({
      label,
      size : SCENE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Lazily (re)create the depth attachment to match the canvas pixel size. */
  protected ensureDepthTexture(label: string): GPUTexture {
    if (
      !this.depthTexture ||
      this.depthTexture.width !== this.canvas.width ||
      this.depthTexture.height !== this.canvas.height
    ) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        label,
        size  : [this.canvas.width, this.canvas.height],
        format: DEPTH_FORMAT,
        usage : GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    return this.depthTexture;
  }

  /**
   * Encode one full-canvas render pass (clear to opaque black) and submit it.
   * `draw` receives the open pass; pass a depth texture (see
   * `ensureDepthTexture`) for depth-tested 3D views.
   */
  protected encodeFrame(
    draw         : (pass: GPURenderPassEncoder) => void,
    depthTexture?: GPUTexture,
  ): void {
    const depthAttachment: GPURenderPassDepthStencilAttachment | undefined = depthTexture
      ? {
          view           : depthTexture.createView(),
          depthClearValue: 1.0,
          depthLoadOp    : "clear",
          depthStoreOp   : "store",
        }
      : undefined;
    const encoder = this.device.createCommandEncoder();
    const pass    = encoder.beginRenderPass({
      colorAttachments: [{
        view      : this.context.getCurrentTexture().createView(),
        clearValue: [0, 0, 0, 1],
        loadOp    : "clear",
        storeOp   : "store",
      }],
      ...(depthAttachment ? { depthStencilAttachment: depthAttachment } : {}),
    });
    draw(pass);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
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

  /**
   * Observe the bound canvas for content-box resizes (unless `autoResize` is
   * off or ResizeObserver is unavailable, e.g. headless tests). On a change
   * the canvas backing store is re-sized immediately, the viewport hook fires,
   * and a frame is requested so the new size is actually drawn.
   */
  private observeCanvasResize(canvas: HTMLCanvasElement): void {
    this.unobserveCanvasResize();
    if (!this.autoResize) return;
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeCanvasToDisplaySize()) this.onViewportChanged();
      this.engine?.requestRender();
    });
    this.resizeObserver.observe(canvas);
  }

  private unobserveCanvasResize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  private resizeCanvasToDisplaySize(): boolean {
    if (!this.canvas || !this.context) return false;
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
      return true;
    }
    return false;
  }

  /** Post-control hook for view-specific state constraints. */
  protected clampState(state: State): State {
    return state;
  }

  /** Bind this view to its owning ViewerEngine instance (used for `requestRender`). */
  setOwner(engine: ViewerEngine): void {
    this.engine = engine;
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
    // First user input stops auto-rotate permanently.
    this.engine?.stopAutoRotate();

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

    // First user input stops auto-rotate permanently.
    this.engine?.stopAutoRotate();

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
    if (!this.engine || this.localControls.length === 0) return;

    const initial = this.engine.getState();
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
    this.engine.setState(state);
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
  protected getAxisMap(): AxisMap | undefined {
    return undefined;
  }
}
