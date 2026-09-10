/**
 * SurfaceLayer - 3D surface rendering
 * 
 * Supports:
 * - OBJ file loading
 * - Built-in primitive geometries (cube, sphere, axis)
 * - Surface and wireframe rendering
 * - Orientation indicators
 */

import type {
  Data,
  LayerConfig,
  Vec3,
} from "../../../state/schema";
import type { AABB, SurfaceGeometry } from "../../../state/schema";
import { parseOBJ } from "../../../dataset/adapters/mesh";
import {
  UNIT_CUBE,
  dataSourceChanged,
  optBoolean,
  optVec3,
  parseHexColor,
  aabbFromPositions,
  resolveDataUrl,
} from "../../../utils";
import {
  BaseLayer,
  transformAABB,
  type Geometry,
  type LayerParams,
  type Shader,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// SURFACE TYPES (owned by state/schema.ts — re-exported for existing imports)
// ============================================================================

export type { AABB, SurfaceGeometry };

// === Built-in Geometries ===

/** Unit cube [0,1]³ - 36 vertices */
export function createCube(): SurfaceGeometry {
  const positions = new Float32Array(UNIT_CUBE);

  const normals = new Float32Array([
    // Front
    0, 0, 1,  0, 0, 1,  0, 0, 1,
    0, 0, 1,  0, 0, 1,  0, 0, 1,
    // Back
    0, 0, -1,  0, 0, -1,  0, 0, -1,
    0, 0, -1,  0, 0, -1,  0, 0, -1,
    // Top
    0, 1, 0,  0, 1, 0,  0, 1, 0,
    0, 1, 0,  0, 1, 0,  0, 1, 0,
    // Bottom
    0, -1, 0,  0, -1, 0,  0, -1, 0,
    0, -1, 0,  0, -1, 0,  0, -1, 0,
    // Right
    1, 0, 0,  1, 0, 0,  1, 0, 0,
    1, 0, 0,  1, 0, 0,  1, 0, 0,
    // Left
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
  ]);

  return { positions, normals, vertexCount: 36 };
}

/** Wireframe cube - 24 vertices (line-list) */
export function createWireframeCube(): SurfaceGeometry {
  const positions = new Float32Array([
    // Bottom face edges
    0, 0, 0,  1, 0, 0,
    1, 0, 0,  1, 0, 1,
    1, 0, 1,  0, 0, 1,
    0, 0, 1,  0, 0, 0,
    // Top face edges
    0, 1, 0,  1, 1, 0,
    1, 1, 0,  1, 1, 1,
    1, 1, 1,  0, 1, 1,
    0, 1, 1,  0, 1, 0,
    // Vertical edges
    0, 0, 0,  0, 1, 0,
    1, 0, 0,  1, 1, 0,
    1, 0, 1,  1, 1, 1,
    0, 0, 1,  0, 1, 1,
  ]);

  return { positions, vertexCount: 24 };
}

// === Surface Parameters ===

export interface SurfaceConfig {
  source?        : Data;
  size?          : Vec3;
  /** Whether to re-normalize by surface AABB into centered [0,1]³ (with margin). */
  fitToUnitAABB? : boolean;
  /**
   * User-specified bounding box (in normalized [0,1]³ space after size scaling).
   * If provided, skips expensive AABB computation from surface data.
   * Useful for large surfaces where computing bounds is slow.
   */
  bounds?        : AABB;
}

/**
 * Options accepted in `LayerConfig.options` for {@link SurfaceLayer}.
 * `dataSize` maps to the constructor config's `size`.
 */
export interface SurfaceOptions extends Omit<SurfaceConfig, "source" | "size"> {
  /** Volume dimensions [width, height, depth] */
  dataSize? : Vec3;
}

/** `LayerConfig` with the surface layer's typed options bag. */
export type SurfaceLayerConfig = LayerConfig<SurfaceOptions>;

export class SurfaceLayerParams implements LayerParams {
  color        : Vec3 = [0.6, 0.6, 0.6];
  opacity                = 1.0;
  wireframe              = false;
  doubleSided            = false;

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  // Layout matches shader SurfaceParams struct:
  // color(3f), opacity(1f), flags(1u), _pad(3f) = 8 values = 32 bytes
  private readonly _buffer          = new Float32Array(8);
  private readonly _bufferFlagsView = new DataView(this._buffer.buffer);
  toBuffer(): Float32Array {
    const flags =
      (this.wireframe   ? 1 : 0) |
      (this.doubleSided ? 2 : 0);
    const b = this._buffer;
    b[0] = this.color[0];
    b[1] = this.color[1];
    b[2] = this.color[2];
    b[3] = this.opacity;
    this._bufferFlagsView.setUint32(16, flags, true);
    return b;
  }
}

// === Surface Layer ===

/** Module-level guard so the "large surface" perf hint is logged at most once per session. */
let warnedLargeAABB = false;

export class SurfaceLayer extends BaseLayer {
  static readonly layerType = "surface";
  static fromConfig(id: string, desc: SurfaceLayerConfig): SurfaceLayer {
    const opts = desc.options ?? {};
    return new SurfaceLayer(id, {
      source        : desc.data,
      size          : optVec3(opts.dataSize),
      fitToUnitAABB : optBoolean(opts.fitToUnitAABB),
      bounds        : optAABB(opts.bounds),
    });
  }
  private params           : SurfaceLayerParams;
  private source?          : Data;
  private size             : Vec3;
  private surfaceGeometry? : SurfaceGeometry;
  private _aabb?           : AABB;
  private userBounds?      : AABB;  // User-specified bounds to skip computation
  private fitToUnitAABB    = false;
  private isWireframe      = false;
  private shadingMode      : "surface" | "flat" | "wireframe" | "xray" = "surface";
  private isSurfaceLoaded  = false;

  constructor(id?: string, config?: SurfaceConfig) {
    super(id);
    this.params         = new SurfaceLayerParams();
    this.source         = config?.source;
    this.size           = config?.size ?? [1, 1, 1];
    this.fitToUnitAABB  = config?.fitToUnitAABB ?? false;
    // User can provide bounds upfront to avoid expensive AABB computation
    this.userBounds     = config?.bounds;
    if (this.userBounds) {
      this._aabb = this.userBounds;
    }
  }

  /**
   * Pull surface-style fields out of `desc.render` (color / opacity / wireframe /
   * doubleSided / shading). All material settings now live on the shared `Render`
   * config; there is no separate `options.material` block.
   */
  protected override applyRenderConfig(desc: LayerConfig): void {
    super.applyRenderConfig(desc);
    const render = desc.render;
    if (render?.color !== undefined) {
      const rgb = parseHexColor(render.color);
      if (rgb) this.params.color = rgb;
    }
    this.params.wireframe   = render?.wireframe   ?? false;
    this.params.doubleSided = render?.doubleSided ?? false;
    this.isWireframe        = this.params.wireframe;
    this.shadingMode        = render?.shading ?? (this.isWireframe ? "wireframe" : "surface");
  }

  /**
   * Initialize surface data. Driven through the layer's single tracked load
   * (`ensureLoaded`) once the GPU device is ready — a rejection is
   * recorded as `loadError` and signaled to every referencing view, so it
   * must propagate, not be logged away.
   */
  override async initAsync(): Promise<void> {
    if (this.isSurfaceLoaded) return;

    // Load from source if available (pre-parsed geometry, custom fetch,
    // urlTemplate, or plain GET)
    if (this.source) {
      await this.loadSurfaceFromSource();
    } else {
      // Default to wireframe cube if no source
      this.useWireframeCube();
      this.isSurfaceLoaded = true;
    }
  }

  /** Check if surface data is ready for rendering */
  override get isReady(): boolean {
    return this.isSurfaceLoaded && !!this.surfaceGeometry;
  }

  /**
   * Update the data source and reload the surface.
   * Compares source identity (url / urlTemplate / fetch / pyramid / geometry)
   * to avoid redundant reloads.
   *
   * The reload is a fresh tracked load — the settled `loadError` is
   * cleared up front (status flips back to `"loading"`) and the new
   * generation's waiters resolve or reject with the new outcome. The
   * rejection is acknowledged here because the failure is already published
   * through `loadError` and the render channel.
   */
  override setSource(source: Data): void {
    if (!dataSourceChanged(source, this.source)) return;
    this.source           = source;
    // Reset so loadSurfaceFromSource re-fetches
    this.isSurfaceLoaded  = false;
    this.surfaceGeometry  = undefined;
    this._aabb            = this.userBounds;
    void this.restartLoad().catch(() => {});
  }

  /**
   * Load surface data from source. Adopts pre-parsed `Data.geometry` when
   * present (dataset handoff — no network request, no second parse);
   * otherwise fetches text via `fetch`/`url` and parses it. Throws on
   * failure — the tracked-load wrapper records it as `loadError`.
   */
  private async loadSurfaceFromSource(): Promise<void> {
    if (!this.source || this.isSurfaceLoaded) return;

    const geometry = optSurfaceGeometry(this.source.geometry);
    if (geometry) {
      this.setSurfaceGeometry(geometry);
    } else {
      let surfaceText: string;

      if (this.source.fetch) {
        const buffer = await this.source.fetch();
        surfaceText = new TextDecoder().decode(buffer);
      } else {
        const resp = await fetch(resolveDataUrl(this.source));
        if (!resp.ok) throw new Error(`Surface fetch failed: ${resp.status}`);
        surfaceText = await resp.text();
      }

      this.loadOBJ(surfaceText);
    }

    this.isSurfaceLoaded = true;
    this.geometryVersion++;

    // Normalize surface to [0,1]³ space based on size
    if (this.surfaceGeometry && this.size) {
      this.normalizeSurface();
    }
  }

  /** Normalize surface coordinates from world space [0, size] to unit space [0, 1] */
  private normalizeSurface(): void {
    if (!this.surfaceGeometry) return;

    const positions = this.surfaceGeometry.positions;
    const [sx, sy, sz] = this.size;

    // Pass 1: per-axis pre-bounds. Used both to detect if the input is already
    // in [0,1]³ and (when not) to compute scale factors below.
    const { min: preMin, max: preMax } = aabbFromPositions(positions);
    const alreadyNormalized =
      preMin[0] >= -1e-3 && preMin[1] >= -1e-3 && preMin[2] >= -1e-3 &&
      preMax[0] <= 1 + 1e-3 && preMax[1] <= 1 + 1e-3 && preMax[2] <= 1 + 1e-3;

    if (!alreadyNormalized) {
      const invX = sx !== 0 ? 1 / sx : 1;
      const invY = sy !== 0 ? 1 / sy : 1;
      const invZ = sz !== 0 ? 1 / sz : 1;
      for (let i = 0; i < positions.length; i += 3) {
        positions[i]     *= invX;
        positions[i + 1] *= invY;
        positions[i + 2] *= invZ;
      }
    }

    let fittedNormalizedSurface = false;
    let postBounds: ReturnType<typeof aabbFromPositions> | undefined;

    if (this.fitToUnitAABB) {
      // Recompute bounds after the optional normalization pass.
      postBounds = aabbFromPositions(positions);
      const { min: postMin, max: postMax } = postBounds;
      const rx = postMax[0] - postMin[0];
      const ry = postMax[1] - postMin[1];
      const rz = postMax[2] - postMin[2];
      if (rx > 1e-12 && ry > 1e-12 && rz > 1e-12) {
        const fitScale = 0.94;
        const invRX = 1 / rx, invRY = 1 / ry, invRZ = 1 / rz;
        for (let i = 0; i < positions.length; i += 3) {
          positions[i]     = 0.5 + ((positions[i]     - postMin[0]) * invRX - 0.5) * fitScale;
          positions[i + 1] = 0.5 + ((positions[i + 1] - postMin[1]) * invRY - 0.5) * fitScale;
          positions[i + 2] = 0.5 + ((positions[i + 2] - postMin[2]) * invRZ - 0.5) * fitScale;
        }
        fittedNormalizedSurface = true;
        // postBounds is now stale (we just rescaled); force recompute below.
        postBounds = undefined;
      }
    }

    if (this.userBounds) {
      this._aabb = this.userBounds;
    } else if (alreadyNormalized && !fittedNormalizedSurface) {
      // Pre-bounds are still valid — no normalization, no fit.
      this._aabb = { min: preMin, max: preMax };
    } else if (postBounds) {
      // Normalization happened (or fit was skipped); postBounds was just computed.
      this._aabb = postBounds;
    } else {
      // Either fit-rescale ran, or we normalized without fitting and didn't take post bounds.
      this._aabb = this.computeAABB();
    }
  }

  /**
   * Load surface from OBJ text
   */
  loadOBJ(objText: string): void {
    this.surfaceGeometry = parseOBJ(objText);
    this._aabb = this.userBounds ?? this.computeAABB();
  }

  /**
   * Set surface data directly
   */
  setSurfaceGeometry(data: SurfaceGeometry): void {
    this.surfaceGeometry = data;
    this._aabb = this.userBounds ?? this.computeAABB();
  }

  /**
   * Use built-in cube geometry
   */
  useCube(): void {
    this.surfaceGeometry = createCube();
    this._aabb = { min: [0, 0, 0], max: [1, 1, 1] };
  }

  /**
   * Use wireframe cube geometry
   */
  useWireframeCube(): void {
    this.surfaceGeometry = createWireframeCube();
    this.isWireframe = true;
    this._aabb = { min: [0, 0, 0], max: [1, 1, 1] };
  }

  /**
   * Get bounding box in world space (model matrix applied to local AABB).
   */
  override getWorldAABB(): { min: Vec3; max: Vec3 } {
    const local = this._aabb ?? { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
    return transformAABB(local.min, local.max, this.modelMatrix);
  }

  /**
   * Get bounding box
   */
  get aabb(): AABB | undefined {
    return this._aabb;
  }

  /**
   * Get raw vertex positions (normalized [0,1]³).
   * Used by Explorer for surface-plane intersection to derive shape outlines.
   */
  getPositions(): Float32Array | undefined {
    return this.surfaceGeometry?.positions;
  }

  private computeAABB(): AABB {
    if (!this.surfaceGeometry) return { min: [0, 0, 0], max: [1, 1, 1] };

    const pos = this.surfaceGeometry.positions;
    const vertexCount = Math.floor(pos.length / 3);
    if (!this.userBounds && !warnedLargeAABB && vertexCount > 1_000_000) {
      warnedLargeAABB = true;
      console.warn(
        `[SurfaceLayer] Large surface detected (${vertexCount} vertices). ` +
        `Computing surface bounds may be slow. Consider providing 'bounds' in SurfaceConfig to skip computing.`
      );
    }
    return aabbFromPositions(pos) as AABB;
  }

  getGeometry(): Geometry {
    // Return empty geometry while surface data is loading
    if (!this.surfaceGeometry) {
      return {
        vertices      : new Float32Array([0, 0, 0]),
        vertexCount   : 0,  // Don't draw anything
        vertexStride  : 12,
        vertexFormat  : "float32x3",
        topology      : this.isWireframe ? "line-list" : "triangle-list",
      };
    }

    return {
      vertices      : this.surfaceGeometry.positions,
      vertexCount   : this.surfaceGeometry.vertexCount,
      vertexStride  : 12, // 3 floats * 4 bytes
      vertexFormat  : "float32x3",
      topology      : this.isWireframe ? "line-list" : "triangle-list",
    };
  }

  override getShader(): Shader {
    const fragmentEntry = (() => {
      switch (this.shadingMode) {
        case "wireframe": return "fs_wireframe";
        case "flat": return "fs_flat";
        case "xray": return "fs_xray";
        case "surface":
        default: return this.isWireframe ? "fs_wireframe" : "fs_surface";
      }
    })();
    return {
      code      : shaderCode,
      vertex    : "vs_main",
      fragment  : fragmentEntry,
    };
  }

  protected getLayerParams(): LayerParams {
    return this.params;
  }
}

/** Structural check for user-specified bounds: Vec3 min + Vec3 max. */
function optAABB(value: unknown): AABB | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<AABB>;
  const min = optVec3(candidate.min);
  const max = optVec3(candidate.max);
  return min && max ? { min, max } : undefined;
}

/**
 * Structural check for pre-parsed `Data.geometry` (config-boundary policy: a
 * wrong-typed value reads as absent and the layer falls back to fetching).
 */
function optSurfaceGeometry(value: unknown): SurfaceGeometry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<SurfaceGeometry>;
  if (!(candidate.positions instanceof Float32Array)) return undefined;
  if (typeof candidate.vertexCount !== "number") return undefined;
  return candidate as SurfaceGeometry;
}
