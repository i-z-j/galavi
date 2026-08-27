/**
 * Layer Base Module
 *
 * BaseLayer — pure-data layer abstraction used by view-owned renderers.
 */
import { mat4 } from "wgpu-matrix";
import type {
  PhysicalSpace,
  Data,
  LayerConfig,
  Render,
  State,
  Vec3,
} from "../../state/schema";
import type { TileSpec, TileFramePlan, TileViewport } from "../../viewer/tile";
import { optNumber, optNumberRecord, optVec2 } from "../../utils";

/** Transform descriptor for model matrix construction */
interface Transform {
  scale?      : Vec3;
  rotate?     : Vec3;
  translate?  : Vec3;
  affine?     : number[];
}

// ============================================================================
// RENDERING TYPES
// ============================================================================

/** Blending mode for layer compositing */
type BlendingMode = NonNullable<Render['blending']>;

// === Load status ===

/**
 * Coarse load state of a layer's data:
 * - `"idle"`    — nothing to load (no source set).
 * - `"loading"` — asynchronous work in flight (e.g. source-descriptor
 *   resolution, async data init).
 * - `"ready"`   — data is renderable (`isReady` holds).
 * - `"error"`   — a failure was recorded; see {@link BaseLayer.loadError}.
 *
 * `BaseLayer`'s default reports `"error"` from the recorded tracked-load
 * failure and otherwise derives from `isReady`; layers with an optional
 * source (tiled image layers) override to also report `"idle"`.
 */
export type LayerLoadStatus = "idle" | "loading" | "ready" | "error";

/**
 * Snapshot of a layer's load state, with the recorded error when
 * `status` is `"error"`. Returned by `BaseView.getLayerStatus`.
 */
export interface LayerLoadState {
  status : LayerLoadStatus;
  error? : Error;
}

/** Vertex attribute definition */
export interface VertexAttribute {
  shaderLocation  : number;
  offset          : number;
  format          : GPUVertexFormat;
}

/** GPU geometry definition */
export interface Geometry {
  vertices        : Float32Array;
  indices?        : Uint16Array | Uint32Array;
  vertexCount     : number;
  vertexStride    : number;
  vertexFormat?   : GPUVertexFormat;
  attributes?     : VertexAttribute[];
  topology        : GPUPrimitiveTopology;
  instanceCount?  : number;
}

/** Shader definition */
export interface Shader {
  code      : string;
  vertex    : string;
  fragment  : string;
  /**
   * Bind-group requirements for this shader. The view's image pipeline reads
   * these to decide which uniforms to allocate and bind. Defaults treat the
   * shader as needing a model-matrix uniform at group(0) binding 2 (overridable
   * by per-layer shaders that don't transform geometry).
   */
  bindings? : ShaderBindings;
}

/** Per-shader bind-group requirements. All flags default to `true`. */
export interface ShaderBindings {
  /** Bind a 64-byte model-matrix uniform. Set false for shaders that ignore world-transform. */
  model?  : boolean;
}

/** Layer parameters (uniform buffer) */
export interface LayerParams {
  toBuffer(): Float32Array;
}

/**
 * Params that accept the shared render opacity. `BaseLayer.getParams()` syncs
 * `BaseLayer.opacity` into params implementing this contract — the single
 * propagation path from state `render.opacity` to every layer's shader.
 */
export interface OpacityParams extends LayerParams {
  setOpacity(opacity: number): void;
}

/** Narrow params to the opacity-sync contract. */
function hasOpacitySync(params: LayerParams): params is OpacityParams {
  return typeof (params as OpacityParams).setOpacity === "function";
}

/**
 * Shared empty 16-byte (vec4) sentinel for storage buffers when a layer has no
 * data yet. Always treated as read-only — never mutate, never write to. Sharing
 * a single instance avoids ~9 redundant 16-byte allocations across layers.
 */
export const MIN_VEC4_BUFFER: Float32Array = new Float32Array(4);

/**
 * Static contract for layer classes registered via `layerRegistry`. Each
 * concrete layer declares its own `layerType` string and `fromConfig` factory,
 * so `registry.ts` collapses to a simple iteration over the class list.
 */
export interface LayerClass {
  readonly layerType: string;
  fromConfig(name: string, desc: LayerConfig): BaseLayer;
}

// ============================================================================
// BASE LAYER
// ============================================================================

/**
 * BaseLayer — pure-data layer abstraction used by view-owned renderers.
 *
 * Shared-instance contract: the ViewerRuntime creates ONE runtime instance per
 * state-layer ID and shares it across every referencing view (per-view GPU
 * resources — pipelines, tile pools — remain per view/layer pair). Custom
 * layers that assumed a fresh instance per referencing view must migrate:
 * instance state (selections, caches, load status) is now shared by all
 * views of that layer ID.
 */
export abstract class BaseLayer {
  readonly id: string;
  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();
  }

  visible   = true;
  opacity   = 1.0;
  colormap  = "gray";
  displayColor?: string;
  blending: BlendingMode = "translucent";

  setColormap(name: string): void {
    if (this.colormap !== name) {
      this.colormap = name;
      this.colormapVersion++;
    }
  }

  /** Set optional single-color ramp override */
  setDisplayColor(color?: string): void {
    const normalized = color?.trim() || undefined;
    if (this.displayColor !== normalized) {
      this.displayColor = normalized;
      this.colormapVersion++;
    }
  }

  // === Versioning (drives GPU pipeline / texture re-upload) ===

  /** Incremented when geometry changes (e.g. shape entries updated) */
  geometryVersion = 0;
  /** Incremented when colormap changes (triggers texture re-upload) */
  colormapVersion = 0;
  /** Incremented when model matrix changes */
  transformVersion = 0;

  // === Transform ===

  /** Model matrix (4×4, column-major Float32Array). Default = identity. */
  modelMatrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);

  /** Inverse model matrix for ray transformations (volume raycasting) */
  invModelMatrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);

  /** Compute model matrix from a Transform. M = Affine × Translate × Rotate × Scale */
  setTransform(desc?: Transform): void {
    if (!desc) {
      // Reset to identity
      mat4.identity(this.modelMatrix);
      mat4.identity(this.invModelMatrix);
      this.transformVersion++;
      return;
    }

    if (desc.affine && desc.affine.length === 16) {
      // Direct affine override
      this.modelMatrix.set(desc.affine);
    } else {
      // wgpu-matrix post-multiplies (mat4.translate(m, v) = m·T), so call in
      // translate → rotate → scale order to build M = T·R·S.
      mat4.identity(this.modelMatrix);

      if (desc.translate) {
        mat4.translate(this.modelMatrix, desc.translate, this.modelMatrix);
      }
      if (desc.rotate) {
        // Euler angles in degrees → radians, applied in XYZ order
        const [rx, ry, rz] = desc.rotate;
        const toRad = Math.PI / 180;
        mat4.rotateX(this.modelMatrix, rx * toRad, this.modelMatrix);
        mat4.rotateY(this.modelMatrix, ry * toRad, this.modelMatrix);
        mat4.rotateZ(this.modelMatrix, rz * toRad, this.modelMatrix);
      }
      if (desc.scale) {
        mat4.scale(this.modelMatrix, desc.scale, this.modelMatrix);
      }
    }

    mat4.inverse(this.modelMatrix, this.invModelMatrix);
    this.transformVersion++;
  }

  // === GPU contract ===

  abstract getGeometry()  : Geometry;

  /**
   * Uniform params for the current frame. Final dispatch point — subclasses
   * implement `getLayerParams()`; this wrapper syncs shared render state into
   * the params at the single point where they leave the layer, so
   * `BaseLayer.opacity` (set via `applyRenderConfig`) reaches every layer's
   * shader (C1).
   */
  getParams(): LayerParams {
    const params = this.getLayerParams();
    if (hasOpacitySync(params)) params.setOpacity(this.opacity);
    return params;
  }

  /** Layer-specific params, before shared-state sync (see `getParams`). */
  protected abstract getLayerParams(): LayerParams;

  /**
   * WGSL source for this layer. Subclasses set this in their constructor (or as
   * a class field) so the default `getShader()` returns
   * `{ code: shaderCode, vertex: "vs_main", fragment: "fs_main" }`. Layers with
   * non-standard entry points (e.g. NetworkLayer's `vs_node`/`fs_node`,
   * SurfaceLayer's per-shadingMode dispatch) override `getShader()` directly
   * and may leave this as the default empty string.
   */
  protected shaderCode: string = "";

  /** Default shader descriptor — subclasses may override for non-standard entry points. */
  getShader(): Shader {
    return {
      code      : this.shaderCode,
      vertex    : "vs_main",
      fragment  : "fs_main",
    };
  }

  /** Get storage buffer data (e.g. point positions). Returns null if not applicable. */
  getStorageData(): { data: Float32Array; label?: string } | null {
    return null;
  }

  /**
   * Returns bounding box in world space. Layers without intrinsic geometry
   * bounds (points / vectors / shapes / segmentation / network /
   * tracks / slice) return `undefined` so view scene-bounds logic skips them.
   * Layers with real bounds (e.g. SurfaceLayer, VolumeLayer) override.
   */
  getWorldAABB(): { min: Vec3; max: Vec3 } | undefined {
    return undefined;
  }

  // === Render-request channel ===

  /**
   * Owner-injected render requester. Layers call `this.requestRender()` from
   * async sites (tile uploads, surface loads) to schedule a frame without
   * mutating shared state. Wired via `attach`; cleared via `detach`.
   *
   * The channel is attached ONCE by the owning ViewerRuntime, which
   * fans each signal out to every referencing view (readiness waiters,
   * render scheduling). Views never attach — a second `attach` would
   * overwrite the runtime's channel.
   */
  private _requestRender: () => void = () => {};
  protected requestRender(): void { this._requestRender(); }

  /** Attach to the render-request channel. Called once by the owning ViewerRuntime. */
  attach(ctx: { requestRender: () => void }): void {
    this._requestRender = ctx.requestRender;
  }

  /** Detach the render-request channel. Called by the runtime on destroy. */
  detach(): void {
    this._requestRender = () => {};
  }

  // === Tile / data lifecycle (override in tileable layers) ===

  /**
   * Monotonic "data identity" version. Bumped by tiled layers when the
   * underlying source / selection / slice index changes so the view-side
   * LayerRenderer can drop its TilePool residency. Geometry changes use
   * `geometryVersion` instead.
   */
  dataVersion = 0;

  /** Whether data is ready for rendering */
  get isReady(): boolean {
    return true;
  }

  /**
   * Coarse load state — see {@link LayerLoadStatus}. The default
   * derives from the tracked load: a recorded failure reports `"error"`,
   * otherwise `isReady` decides between `"ready"` and `"loading"`. Layers
   * with an optional source (tiled image layers) override to also report
   * `"idle"`.
   */
  get loadStatus(): LayerLoadStatus {
    if (this._loadError !== undefined) return "error";
    return this.isReady ? "ready" : "loading";
  }

  /**
   * The recorded load failure when `loadStatus` is `"error"`, else
   * `undefined`. The original rejection is preserved (adapters wrap their
   * open failures with context and a `cause` chain), so apps can distinguish
   * an unknown source type from unsupported metadata and network/CORS
   * failures.
   */
  get loadError(): Error | undefined {
    return this._loadError;
  }

  // === Tracked async load ===

  /**
   * One state-layer identity owns one data runtime and one settled load:
   * the owning ViewerRuntime starts the tracked load exactly once
   * via {@link ensureLoaded} and every consumer shares its outcome through
   * `loadStatus` / `loadError` and the render-request channel. Dynamic
   * source replacement starts a new load generation via {@link restartLoad}.
   */
  private _loadPromise?   : Promise<void>;
  private _loadError?     : Error;
  private _loadGeneration = 0;

  /**
   * Start this layer's tracked async load, or return the one already in
   * flight. Runs {@link initAsync} at most once per load generation; later
   * calls share the same promise. A rejection is recorded as
   * {@link loadError} (so `loadStatus` settles to `"error"` instead of
   * hanging in `"loading"`), signaled through the render channel, and
   * rethrown to the caller — callers must handle the rejection.
   *
   * Called by the owning ViewerRuntime once the GPU device is ready.
   */
  ensureLoaded(): Promise<void> {
    if (!this._loadPromise) this._loadPromise = this._trackLoad();
    return this._loadPromise;
  }

  /**
   * Clear the settled load state and start a fresh tracked load (dynamic
   * source replacement). The old error is cleared up front — `loadStatus`
   * flips from `"error"` back to `"loading"` — and waiters of the new
   * generation settle through the render channel when it completes.
   */
  protected restartLoad(): Promise<void> {
    this._loadPromise = undefined;
    this._loadError   = undefined;
    return this.ensureLoaded();
  }

  /**
   * Run one load generation of {@link initAsync}, recording its outcome.
   * The generation guard keeps a superseded load (source replaced while in
   * flight) from clobbering the newer generation's state.
   */
  private _trackLoad(): Promise<void> {
    const generation = ++this._loadGeneration;
    const current = () => this._loadGeneration === generation;
    return Promise.resolve()
      .then(() => this.initAsync())
      .then(
        () => {
          // Settle signal — the runtime fans it out to every referencing
          // view: readiness waiters resolve, a frame is scheduled.
          if (current()) this.requestRender();
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          if (current()) {
            this._loadError = error;
            this.requestRender();
          }
          throw error;
        },
      );
  }

  /**
   * Async data initialization (e.g. fetch + parse a mesh). Default is a
   * no-op; override in layers that need to load data before they can render.
   *
   * Invoked through the layer's single tracked load
   * ({@link ensureLoaded}) once the GPU device is ready — never concurrently,
   * never more than once per load generation. Overriding implementations
   * MUST let failures propagate (do not catch-and-log): the rejection is
   * recorded as {@link loadError} so readiness observers settle.
   */
  initAsync(): Promise<void> { return Promise.resolve(); }

  /**
   * Tiled-image descriptor. Returns a `TileSpec` when this layer is a tiled
   * image source ready for residency allocation; returns `null` for non-tiled
   * layers, or for tiled layers whose source is not yet set.
   *
   * GPU residency (the `TilePool` and its surrounding `TileManager`) is owned
   * by the view-side `LayerRenderer`; the layer itself never touches the GPU.
   */
  getTileSpec(): TileSpec | null {
    return null;
  }

  /**
    * Per-frame tile request. Returns the visible `TilePlan` and `TileLoader`, or
    * `null` when nothing should be loaded (e.g. no source). The layer also
    * updates internal render params such as viewport and dynamic grid metadata.
   */
  planTiles(
    _viewport: TileViewport,
  ): TileFramePlan | null {
    return null;
  }

  /** Get current pyramid level */
  getCurrentLevel(): number {
    return 0;
  }

  /** Physical source resolution for a pyramid level in this layer's rendered axes. */
  getLevelResolution(_level: number): number | undefined {
    return undefined;
  }

  /** Set contrast range */
  setContrast(_min: number, _max: number): void {}

  /** Update data source */
  setSource(_source: Data): void {}

  /** Set a non-spatial selection key (e.g. channel `c`, timepoint `t`). */
  setSelection(_key: string, _value: number): void {}

  /** Convenience: set timepoint via the `t` selection key. */
  setTimepoint(t: number): void {
    this.setSelection("t", t);
  }

  // === Per-frame hook ===

  /**
   * Per-frame hook invoked by the View after `applyConfig` and before render.
   * Override to update state that depends on the current camera / sibling layers
   * (e.g. `ShapesLayer` recomputing entries for the current slice plane).
   *
   * Default is a no-op. To request a render after async work completes, call
   * `this.requestRender()` (the inherited render channel wired by `attach`).
   *
   * @param state    Current shared state
   * @param siblings Map of layer id → { desc, layer } for cross-layer dependencies
   */
  prepareFrame(
    _state      : State,
    _siblings   : Map<string, { desc: LayerConfig; layer: BaseLayer }>,
  ): void {}

  // === Config dispatch ===

  /** Reference-equality cache for `applyConfig`. */
  private _lastAppliedDesc?     : LayerConfig;
  private _lastAppliedPhysical? : PhysicalSpace;

  /**
   * Apply a LayerConfig to this layer's render/option state.
   * Called each frame before rendering. Subclasses normally override one of the
   * targeted hooks below (`applyRenderConfig`, `applyTransformConfig`,
   * `applyOptions`, `applyDataSource`) instead of overriding this method.
   *
   * Skips work when both `desc` and `physical` are reference-equal to the
   * previous call — render-only triggers (e.g. tile uploads via
   * `ViewerRuntime.requestRender()`) reuse the same state refs and need no re-apply.
   *
   * G1 invariant: `applyDataSource` must call `setSource(desc.data)` exactly
   * once when `desc.data` is present. Re-fetch is prevented downstream by
   * `sourceChanged()` guards inside layers that fetch external resources
   * (SurfaceLayer, ShapesLayer). Do NOT bypass this single dispatch path.
   */
  applyConfig(desc: LayerConfig, physical?: PhysicalSpace): void {
    if (this._lastAppliedDesc === desc && this._lastAppliedPhysical === physical) return;
    this._lastAppliedDesc     = desc;
    this._lastAppliedPhysical = physical;
    this.applyRenderConfig(desc);
    this.applyTransformConfig(desc, physical);
    this.applyOptions(desc);
    this.applyDataSource(desc);
  }

  /** Render-related properties: visible, opacity, blending, colormap, color, contrast. */
  protected applyRenderConfig(desc: LayerConfig): void {
    if (desc.render?.visible !== undefined) this.visible = desc.render.visible;
    if (desc.render?.opacity !== undefined) this.opacity = desc.render.opacity;
    if (desc.render?.blending !== undefined) this.blending = desc.render.blending;
    if (desc.render?.colormap !== undefined) this.setColormap(desc.render.colormap);
    // `color` is intentionally clearable: an explicit `undefined` removes the
    // single-color tint so the layer falls back to its colormap LUT.
    if (desc.render && "color" in desc.render) this.setDisplayColor(desc.render.color);

    const contrastLimits = desc.render?.contrastLimits;
    if (contrastLimits) {
      this.setContrast(contrastLimits[0], contrastLimits[1]);
    } else {
      const contrastRange = optVec2(desc.options?.contrastRange);
      if (contrastRange) this.setContrast(contrastRange[0], contrastRange[1]);
    }
  }

  /** Model transform: explicit affine, else physical-space scale and origin. */
  protected applyTransformConfig(desc: LayerConfig, physical?: PhysicalSpace): void {
    if (desc.data?.transform !== undefined) {
      this.setTransform({ affine: desc.data.transform });
    } else if (physical?.spatial) {
      this.setTransform({
        scale    : physical.spatial.size,
        translate: physical.spatial.origin,
      });
    }
  }

  /**
   * Generic options dispatch. Handles `selection` and `timepoint` (forwarded
   * via `setSelection` / `setTimepoint`, no-ops on layers that do not implement
   * them). Subclasses extend by calling `super.applyOptions(desc)` and then
   * dispatching their type-specific keys (e.g. `sliceIndex` for SliceLayer,
   * `points`/`size`/`color` for PointsLayer).
   */
  protected applyOptions(desc: LayerConfig): void {
    const opts = desc.options;
    if (!opts) return;
    const sel = optNumberRecord(opts.selection);
    if (sel) {
      for (const [key, val] of Object.entries(sel)) this.setSelection(key, val);
    }
    const timepoint = optNumber(opts.timepoint);
    if (timepoint !== undefined) this.setTimepoint(timepoint);
  }

  /**
   * Data source dispatch. G1: must call `setSource(desc.data)` exactly once
   * when present. The `sourceChanged()` guard inside concrete `setSource`
   * implementations is the only thing preventing per-frame re-fetches.
   */
  protected applyDataSource(desc: LayerConfig): void {
    if (desc.data) {
      this.setSource(desc.data);
    }
  }
}


// ============================================================================
// BLEND CONFIG HELPER
// ============================================================================

export interface BlendConfig {
  blendState?       : GPUBlendState;
  depthWriteEnabled : boolean;
  depthCompare      : GPUCompareFunction;
}

/**
 * Map a BlendingMode to GPU pipeline blend/depth configuration.
 *
 * | blending      | GPUBlendState                    | depthWrite | depthCompare |
 * |---------------|----------------------------------|------------|--------------|
 * | opaque        | none                             | true       | less         |
 * | translucent   | src-alpha / one-minus-src-alpha  | false      | less         |
 * | additive      | src-alpha / one                  | false      | always       |
 * | minimum       | min equation                     | false      | always       |
 */
export function getBlendConfig(mode: BlendingMode): BlendConfig {
  switch (mode) {
    case "opaque":
      return {
        blendState        : undefined,
        depthWriteEnabled : true,
        depthCompare      : "less",
      };
    case "additive":
      return {
        blendState: {
          color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        },
        depthWriteEnabled : false,
        depthCompare      : "always",
      };
    case "minimum":
      return {
        blendState: {
          color: { srcFactor: "one", dstFactor: "one", operation: "min" },
          alpha: { srcFactor: "one", dstFactor: "one", operation: "min" },
        },
        depthWriteEnabled : false,
        depthCompare      : "always",
      };
    case "translucent":
    default:
      return {
        blendState: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
        depthWriteEnabled : false,
        depthCompare      : "less",
      };
  }
}

// ============================================================================
// AABB TRANSFORM UTILITY
// ============================================================================

/**
 * Transform an axis-aligned bounding box by a 4×4 column-major matrix.
 * Uses the min/max component approach (handles rotation, scale, skew).
 */
export function transformAABB(
  localMin  : Vec3,
  localMax  : Vec3,
  matrix    : Float32Array,
): { min: Vec3; max: Vec3 } {
  const worldMin: Vec3 = [matrix[12], matrix[13], matrix[14]];
  const worldMax: Vec3 = [matrix[12], matrix[13], matrix[14]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const e = matrix[j * 4 + i]; // column-major: element [row=i, col=j]
      const a = e * localMin[j];
      const b = e * localMax[j];
      worldMin[i] += Math.min(a, b);
      worldMax[i] += Math.max(a, b);
    }
  }
  return { min: worldMin, max: worldMax };
}
