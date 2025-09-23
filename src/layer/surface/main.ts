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
} from "../../types";
import {
  UNIT_CUBE,
  parseHexColor,
  sourceChanged,
  aabbFromPositions,
  resolveDataUrl,
} from "../../utils";
import {
  BaseLayer,
  transformAABB,
  type Geometry,
  type LayerParams,
  type Shader,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// SURFACE TYPES (local to surface module)
// ============================================================================

/** Parsed surface geometry from OBJ or similar format */
export interface SurfaceGeometry {
  positions   : Float32Array;
  normals?    : Float32Array;
  uvs?        : Float32Array;
  indices?    : Uint16Array | Uint32Array;
  vertexCount : number;
  indexCount? : number;
}

/** Axis-aligned bounding box */
export interface AABB {
  min : Vec3;
  max : Vec3;
}

// === OBJ Parser ===

export function parseOBJ(objText: string): SurfaceGeometry {
  const positions : number[] = [];
  const normals   : number[] = [];
  const uvs       : number[] = [];

  const vertexPositions : Vec3[] = [];
  const vertexNormals   : Vec3[] = [];
  const vertexUVs       : [number, number][] = [];

  const lines = objText.split("\n");

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case "v": // Vertex position
        vertexPositions.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
        break;

      case "vn": // Vertex normal
        vertexNormals.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
        break;

      case "vt": // Texture coordinate
        vertexUVs.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
        ]);
        break;

      case "f": // Face
        // Handle triangles and quads
        const vertices = parts.slice(1);
        const triangleIndices = triangulate(vertices.length);

        for (const idx of triangleIndices) {
          const vertex = vertices[idx];
          const [vIdx, vtIdx, vnIdx] = parseVertexIndex(vertex);

          if (vIdx !== undefined && vertexPositions[vIdx]) {
            positions.push(...vertexPositions[vIdx]);
          }
          if (vnIdx !== undefined && vertexNormals[vnIdx]) {
            normals.push(...vertexNormals[vnIdx]);
          }
          if (vtIdx !== undefined && vertexUVs[vtIdx]) {
            uvs.push(...vertexUVs[vtIdx]);
          }
        }
        break;
    }
  }

  return {
    positions   : new Float32Array(positions),
    normals     : normals.length > 0 ? new Float32Array(normals) : undefined,
    uvs         : uvs.length > 0 ? new Float32Array(uvs) : undefined,
    vertexCount : positions.length / 3,
  };
}

function parseVertexIndex(vertex: string): [number?, number?, number?] {
  const parts = vertex.split("/");
  const vIdx  = parts[0] ? parseInt(parts[0]) - 1 : undefined;
  const vtIdx = parts[1] ? parseInt(parts[1]) - 1 : undefined;
  const vnIdx = parts[2] ? parseInt(parts[2]) - 1 : undefined;
  return [vIdx, vtIdx, vnIdx];
}

function triangulate(vertexCount: number): number[] {
  // Convert polygon to triangles (fan triangulation)
  const indices: number[] = [];
  for (let i = 1; i < vertexCount - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return indices;
}

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

export class SurfaceLayerParams implements LayerParams {
  color        : Vec3 = [0.6, 0.6, 0.6];
  opacity                = 1.0;
  wireframe              = false;
  doubleSided            = false;

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
  static fromConfig(id: string, desc: LayerConfig): SurfaceLayer {
    return new SurfaceLayer(id, {
      source        : desc.data,
      size          : (desc.options?.dataSize as Vec3) ?? undefined,
      fitToUnitAABB : desc.options?.fitToUnitAABB as boolean | undefined,
      bounds        : desc.options?.bounds as AABB | undefined,
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
    this.params.opacity     = this.opacity;
    this.params.wireframe   = render?.wireframe   ?? false;
    this.params.doubleSided = render?.doubleSided ?? false;
    this.isWireframe        = this.params.wireframe;
    this.shadingMode        = render?.shading ?? (this.isWireframe ? "wireframe" : "surface");
  }

  /** Initialize surface data (called by view after device is ready) */
  override async initAsync(): Promise<void> {
    if (this.isSurfaceLoaded) return;

    // Load from source if available (custom fetch, urlTemplate, or plain GET)
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
   * Compares URLs to avoid redundant reloads.
   */
  override setSource(source: Data): void {
    if (!sourceChanged(source, this.source)) return;
    this.source           = source;
    // Reset so loadSurfaceFromSource re-fetches
    this.isSurfaceLoaded  = false;
    this.surfaceGeometry  = undefined;
    this._aabb            = this.userBounds;
    this.loadSurfaceFromSource();
  }

  /** Load surface data from source */
  private async loadSurfaceFromSource(): Promise<void> {
    if (!this.source || this.isSurfaceLoaded) return;

    try {
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

      this.isSurfaceLoaded = true;
      this.geometryVersion++;

      // Normalize surface to [0,1]³ space based on size
      if (this.surfaceGeometry && this.size) {
        this.normalizeSurface();
      }

      // Notify views so async source reloads rebuild GPU state promptly.
      this.requestRender();
    } catch (err) {
      console.error(`[SurfaceLayer] Failed to load surface:`, err);
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

  getParams(): LayerParams {
    return this.params;
  }
}
