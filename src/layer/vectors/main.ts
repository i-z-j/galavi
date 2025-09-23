/**
 * VectorsLayer - 3D vector field rendering
 *
 * Renders a set of vectors as line segments from a start position
 * along a direction. Uses instanced rendering (one line per vector).
 *
 * Matches napari's Vectors layer for visualizing gradient fields,
 * flow directions, and other oriented data.
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
// VECTORS TYPES
// ============================================================================

export interface VectorEntry {
  start     : Vec3;
  direction : Vec3;
}

export interface VectorsConfig {
  /** Array of vectors (start + direction) */
  vectors?   : VectorEntry[];
  /** Display color (RGB, 0-1) */
  color?     : Vec3;
  /** Line width (default: 1) */
  edgeWidth? : number;
  /** Direction magnitude scale factor (default: 1) */
  length?    : number;
  /** Opacity (0-1) */
  opacity?   : number;
}

// ============================================================================
// VECTORS PARAMETERS
// ============================================================================

export class VectorsLayerParams implements LayerParams {
  color: Vec3 = [1.0, 1.0, 1.0];
  opacity     = 1.0;
  length      = 1.0;
  edgeWidth   = 1.0;

  constructor(config?: VectorsConfig) {
    if (config?.color) this.color = config.color;
    if (config?.opacity !== undefined) this.opacity = config.opacity;
    if (config?.length !== undefined) this.length = config.length;
    if (config?.edgeWidth !== undefined) this.edgeWidth = config.edgeWidth;
  }

  // Layout: color(3f) + opacity(1f) + length(1f) + edge_width(1f) + _pad(2f) = 8 floats = 32 bytes
  private readonly _buffer = new Float32Array(8);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0] = this.color[0];
    b[1] = this.color[1];
    b[2] = this.color[2];
    b[3] = this.opacity;
    b[4] = this.length;
    b[5] = this.edgeWidth;
    return b;
  }
}

// ============================================================================
// VECTORS LAYER
// ============================================================================

export class VectorsLayer extends BaseLayer {
  static readonly layerType = "vectors";
  static fromConfig(id: string, desc: LayerConfig): VectorsLayer {
    return new VectorsLayer(id, {
      vectors   : desc.options?.vectors as VectorEntry[] | undefined,
      color     : (desc.options?.color as Vec3) ?? undefined,
      edgeWidth : desc.options?.edgeWidth as number | undefined,
      length    : desc.options?.length as number | undefined,
      opacity   : desc.options?.opacity as number | undefined,
    });
  }
  protected override shaderCode = shaderCode;
  private params     : VectorsLayerParams;
  private _vectors   : VectorEntry[] = [];
  private _gpuBuffer : Float32Array = MIN_VEC4_BUFFER;

  constructor(id?: string, config?: VectorsConfig) {
    super(id);
    this.params = new VectorsLayerParams(config);
    if (config?.vectors) {
      this._vectors = [...config.vectors];
    }
    this.rebuildBuffer();
  }

  /** Get current vectors */
  get vectors(): readonly VectorEntry[] {
    return this._vectors;
  }

  /** Get vector count */
  get count(): number {
    return this._vectors.length;
  }

  /** Replace all vectors */
  setVectors(vectors: VectorEntry[]): void {
    this._vectors = vectors.map(v => ({
      start: [...v.start] as Vec3,
      direction: [...v.direction] as Vec3,
    }));
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Add a single vector */
  addVector(entry: VectorEntry): void {
    this._vectors.push({
      start: [...entry.start] as Vec3,
      direction: [...entry.direction] as Vec3,
    });
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Clear all vectors */
  clearVectors(): void {
    this._vectors = [];
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Set display color */
  setColor(color: Vec3): void {
    this.params.color = color;
  }

  /** Set direction magnitude scale */
  setLength(length: number): void {
    this.params.length = length;
  }

  /** Build GPU storage buffer: 2 × vec4f per vector (start, direction) */
  private rebuildBuffer(): void {
    if (this._vectors.length === 0) {
      this._gpuBuffer = MIN_VEC4_BUFFER;
      return;
    }
    const buf = new Float32Array(this._vectors.length * 8);
    for (let i = 0; i < this._vectors.length; i++) {
      const v = this._vectors[i];
      const off = i * 8;
      buf[off + 0] = v.start[0];
      buf[off + 1] = v.start[1];
      buf[off + 2] = v.start[2];
      buf[off + 3] = 0; // padding
      buf[off + 4] = v.direction[0];
      buf[off + 5] = v.direction[1];
      buf[off + 6] = v.direction[2];
      buf[off + 7] = 0; // padding
    }
    this._gpuBuffer = buf;
  }

  // === BaseLayer interface ===

  getGeometry(): Geometry {
    return {
      vertices      : EMPTY_VERTEX_BUFFER,
      vertexCount   : 2,
      vertexStride  : 4,
      vertexFormat  : "float32",
      topology      : "line-list",
      instanceCount : this._vectors.length,
    };
  }

  getParams(): LayerParams {
    return this.params;
  }

  override getStorageData(): { data: Float32Array; label?: string } | null {
    return { data: this._gpuBuffer, label: `Vectors ${this.id} Data` };
  }
}
