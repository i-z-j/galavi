/**
 * PointsLayer - 3D point annotation rendering
 *
 * Renders a set of 3D points as billboard circles using instanced rendering.
 * Each point is a camera-facing quad with circular fragment discard.
 *
 * Matches napari's Points layer for spatial annotation of positions
 * in volumetric datasets.
 */

import type { LayerConfig, Vec3 } from "../../types";
import { EMPTY_VERTEX_BUFFER } from "../../utils";
import {
  BaseLayer,
  MIN_VEC4_BUFFER,
  type Geometry,
  type LayerParams,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// POINTS TYPES
// ============================================================================

/** Points configuration */
export interface PointsConfig {
  /** Array of 3D point positions */
  points?    : Vec3[];
  /** Point display size in world-space units (default: 0.01) */
  size?      : number;
  /** Point color (RGB, 0-1) */
  color?     : Vec3;
  /** Opacity (0-1) */
  opacity?   : number;
  /** Anti-aliased edge width (0-1, default: 0.15) */
  edgeWidth? : number;
}

// ============================================================================
// POINTS PARAMETERS
// ============================================================================

export class PointsLayerParams implements LayerParams {
  color: Vec3 = [1.0, 0.0, 0.0];
  opacity     = 1.0;
  size        = 0.01;
  edgeWidth   = 0.15;

  constructor(config?: PointsConfig) {
    if (config?.color) this.color = config.color;
    if (config?.opacity !== undefined) this.opacity = config.opacity;
    if (config?.size !== undefined) this.size = config.size;
    if (config?.edgeWidth !== undefined) this.edgeWidth = config.edgeWidth;
  }

  // Layout matches shader Params struct:
  // color(3f) + opacity(1f) + size(1f) + edge_width(1f) + _pad(2f) = 8 floats = 32 bytes
  private readonly _buffer = new Float32Array(8);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0] = this.color[0];
    b[1] = this.color[1];
    b[2] = this.color[2];
    b[3] = this.opacity;
    b[4] = this.size;
    b[5] = this.edgeWidth;
    return b;
  }
}

// ============================================================================
// POINTS DATA
// ============================================================================

export class PointsLayer extends BaseLayer {
  static readonly layerType = "points";
  static fromConfig(id: string, desc: LayerConfig): PointsLayer {
    return new PointsLayer(id, {
      points    : (desc.options?.points as Vec3[]) ?? undefined,
      size      : desc.options?.size as number | undefined,
      color     : (desc.options?.color as Vec3) ?? undefined,
      opacity   : desc.options?.opacity as number | undefined,
      edgeWidth : desc.options?.edgeWidth as number | undefined,
    });
  }

  protected override shaderCode = shaderCode;
  private params          : PointsLayerParams;
  private _points         : Vec3[] = [];
  /** GPU-friendly packed positions as vec4f (xyz + padding) */
  private _positionBuffer : Float32Array = new Float32Array(0);

  constructor(id?: string, config?: PointsConfig) {
    super(id);
    this.params = new PointsLayerParams(config);
    if (config?.points) {
      this._points = [...config.points];
    }
    this.rebuildPositionBuffer();
  }

  // === Point manipulation ===

  /** Get current points array */
  get points(): readonly Vec3[] {
    return this._points;
  }

  /** Get the packed position buffer for GPU upload (vec4f per point) */
  get positionBuffer(): Float32Array {
    return this._positionBuffer;
  }

  /** Get point count */
  get count(): number {
    return this._points.length;
  }

  /** Add a point at position */
  addPoint(position: Vec3): void {
    this._points.push([...position] as Vec3);
    this.rebuildPositionBuffer();
    this.geometryVersion++;
  }

  /** Remove a point by index */
  removePoint(index: number): void {
    if (index >= 0 && index < this._points.length) {
      this._points.splice(index, 1);
      this.rebuildPositionBuffer();
      this.geometryVersion++;
    }
  }

  /** Move a point to a new position */
  movePoint(index: number, position: Vec3): void {
    if (index >= 0 && index < this._points.length) {
      this._points[index] = [...position] as Vec3;
      this.rebuildPositionBuffer();
      this.geometryVersion++;
    }
  }

  /** Replace all points */
  setPoints(points: Vec3[]): void {
    this._points = points.map(p => [...p] as Vec3);
    this.rebuildPositionBuffer();
    this.geometryVersion++;
  }

  /** Clear all points */
  clearPoints(): void {
    this._points = [];
    this.rebuildPositionBuffer();
    this.geometryVersion++;
  }

  /** Set point display size */
  setSize(size: number): void {
    this.params.size = size;
  }

  /** Set point color */
  setColor(color: Vec3): void {
    this.params.color = color;
  }

  /** Set point opacity */
  setPointOpacity(opacity: number): void {
    this.params.opacity = opacity;
  }

  protected override applyOptions(desc: LayerConfig): void {
    super.applyOptions(desc);
    if (desc.options) {
      const opts = desc.options;
      if (opts.points !== undefined) this.setPoints(opts.points as Vec3[]);
      if (opts.size !== undefined) this.setSize(opts.size as number);
      if (opts.color !== undefined) this.setColor(opts.color as Vec3);
    }
  }

  /** Build the packed Float32Array of vec4f positions for GPU storage buffer */
  private rebuildPositionBuffer(): void {
    const buf = new Float32Array(this._points.length * 4);
    for (let i = 0; i < this._points.length; i++) {
      buf[i * 4 + 0] = this._points[i][0];
      buf[i * 4 + 1] = this._points[i][1];
      buf[i * 4 + 2] = this._points[i][2];
      buf[i * 4 + 3] = 1.0; // padding / w
    }
    this._positionBuffer = buf;
  }

  // === BaseLayer interface ===

  getGeometry(): Geometry {
    return {
      vertices      : EMPTY_VERTEX_BUFFER,
      vertexCount   : 6,        // 6 vertices per quad (2 triangles)
      vertexStride  : 4,        // Dummy — actual vertices from const array in shader
      vertexFormat  : "float32", // Single float to match 4-byte stride (positions come from storage buffer)
      topology      : "triangle-list",
      instanceCount : this._points.length,
    };
  }

  getParams(): LayerParams {
    return this.params;
  }

  /** Provide position data as a storage buffer for the shader.
   *  Always returns a buffer (minimum 16 bytes) so the bind group
   *  matches the pipeline layout which always declares binding 3. */
  override getStorageData(): { data: Float32Array; label?: string } | null {
    const data = this._points.length > 0
      ? this._positionBuffer
      : MIN_VEC4_BUFFER; // shared sentinel so the bind group is valid
    return { data, label: `Points ${this.id} Positions` };
  }
}
