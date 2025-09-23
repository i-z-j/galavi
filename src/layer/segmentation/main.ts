/**
 * SegmentationLayer - Categorical label overlay rendering
 *
 * Renders integer label data with a deterministic categorical colormap.
 * Label 0 is treated as transparent background. Supports shape-outline
 * mode and single-label highlighting.
 *
 */

import type {
  Data,
  LayerConfig,
  Vec3,
} from "../../types";
import { EMPTY_VERTEX_BUFFER } from "../../utils";
import {
  BaseLayer,
  MIN_VEC4_BUFFER,
  type Geometry,
  type LayerParams,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// SEGMENTATION TYPES
// ============================================================================

export interface SegmentationConfig {
  /** Data source for tile-based integer label data */
  source?           : Data;
  /** Volume dimensions [width, height, depth] */
  dataSize?         : Vec3;
  /** Hint for number of distinct labels */
  numLabels?        : number;
  /** Highlight a specific label */
  selectedLabel?    : number;
  /** Show only shape outlines (thickness in pixels, 0 = filled) */
  shape?            : number;
  /** Show only the selected label */
  showSelectedOnly? : boolean;
  /** Opacity (0-1) */
  opacity?          : number;
  /** Flat label data (width × height u32 values) */
  data?             : Uint32Array;
  /** Data width */
  width?            : number;
  /** Data height */
  height?           : number;
}

// ============================================================================
// SEGMENTATION PARAMETERS
// ============================================================================

export class SegmentationLayerParams implements LayerParams {
  opacity          = 0.7;
  selectedLabel    = -1;
  shape            = 0;
  showSelectedOnly = false;
  dataWidth        = 0;
  dataHeight       = 0;
  numLabels        = 0;

  constructor(config?: SegmentationConfig) {
    if (config?.opacity !== undefined) this.opacity = config.opacity;
    if (config?.selectedLabel !== undefined) this.selectedLabel = config.selectedLabel;
    if (config?.shape !== undefined) this.shape = config.shape;
    if (config?.showSelectedOnly !== undefined) this.showSelectedOnly = config.showSelectedOnly;
    if (config?.numLabels !== undefined) this.numLabels = config.numLabels;
    if (config?.width !== undefined) this.dataWidth = config.width;
    if (config?.height !== undefined) this.dataHeight = config.height;
  }

  // Layout: opacity(1f) + selected_label(1i) + shape(1f) + show_selected(1f)
  //       + data_width(1u) + data_height(1u) + num_labels(1u) + _pad(1u) = 8 × 4 = 32 bytes
  private readonly _buffer    = new Float32Array(8);
  private readonly _bufferI32 = new Int32Array(this._buffer.buffer);
  private readonly _bufferU32 = new Uint32Array(this._buffer.buffer);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0] = this.opacity;
    this._bufferI32[1] = this.selectedLabel;
    b[2] = this.shape;
    b[3] = this.showSelectedOnly ? 1.0 : 0.0;
    this._bufferU32[4] = this.dataWidth;
    this._bufferU32[5] = this.dataHeight;
    this._bufferU32[6] = this.numLabels;
    this._bufferU32[7] = 0;
    return b;
  }
}

// ============================================================================
// SEGMENTATION LAYER
// ============================================================================

export class SegmentationLayer extends BaseLayer {
  static readonly layerType = "segmentation";
  static fromConfig(id: string, desc: LayerConfig): SegmentationLayer {
    return new SegmentationLayer(id, {
      source           : desc.data,
      dataSize         : (desc.options?.dataSize as Vec3) ?? undefined,
      numLabels        : desc.options?.numLabels as number | undefined,
      selectedLabel    : desc.options?.selectedLabel as number | undefined,
      shape            : desc.options?.shape as number | undefined,
      showSelectedOnly : desc.options?.showSelectedOnly as boolean | undefined,
      opacity          : desc.options?.opacity as number | undefined,
      data             : desc.options?.data as Uint32Array | undefined,
      width            : desc.options?.width as number | undefined,
      height           : desc.options?.height as number | undefined,
    });
  }
  protected override shaderCode = shaderCode;
  private params     : SegmentationLayerParams;
  private _data      : Uint32Array = new Uint32Array(0);
  private _gpuBuffer : Float32Array = MIN_VEC4_BUFFER; // shared sentinel until data is set

  constructor(id?: string, config?: SegmentationConfig) {
    super(id);
    this.params = new SegmentationLayerParams(config);
    if (config?.data) {
      this.setData(config.data, config.width ?? 0, config.height ?? 0);
    }
  }

  /** Set label data */
  setData(data: Uint32Array, width: number, height: number): void {
    this._data = data;
    this.params.dataWidth   = width;
    this.params.dataHeight  = height;
    // Pack as u32 → store via Float32Array view (same bytes)
    const buf = new Float32Array(Math.max(4, data.length));
    new Uint32Array(buf.buffer).set(data);
    this._gpuBuffer = buf;
    this.geometryVersion++;
  }

  /** Set the selected label for highlighting */
  setSelectedLabel(label: number): void {
    this.params.selectedLabel = label;
  }

  /** Set shape outline mode (0 = filled, >0 = outline-only) */
  setShape(thickness: number): void {
    this.params.shape = thickness;
  }

  /** Set show-selected-only mode */
  setShowSelectedOnly(show: boolean): void {
    this.params.showSelectedOnly = show;
  }

  // === Config dispatch ===

  protected override applyOptions(desc: LayerConfig): void {
    super.applyOptions(desc);
    const opts = desc.options;
    if (!opts) return;
    if (opts.numLabels !== undefined)        this.params.numLabels        = opts.numLabels as number;
    if (opts.selectedLabel !== undefined)    this.setSelectedLabel(opts.selectedLabel as number);
    if (opts.shape !== undefined)            this.setShape(opts.shape as number);
    if (opts.showSelectedOnly !== undefined) this.setShowSelectedOnly(opts.showSelectedOnly as boolean);
    if (opts.opacity !== undefined)          this.opacity = opts.opacity as number;
    if (opts.data !== undefined) {
      const data   = opts.data as Uint32Array;
      const width  = (opts.width  as number | undefined) ?? this.params.dataWidth;
      const height = (opts.height as number | undefined) ?? this.params.dataHeight;
      if (data !== this._data || width !== this.params.dataWidth || height !== this.params.dataHeight) {
        this.setData(data, width, height);
      }
    }
  }

  // === BaseLayer interface ===

  getGeometry(): Geometry {
    return {
      vertices      : EMPTY_VERTEX_BUFFER,
      vertexCount   : 6,
      vertexStride  : 4,
      vertexFormat  : "float32",
      topology      : "triangle-list",
      instanceCount : 1,
    };
  }

  getParams(): LayerParams {
    return this.params;
  }

  override getStorageData(): { data: Float32Array; label?: string } | null {
    return { data: this._gpuBuffer, label: `Segmentation ${this.id} Labels` };
  }

  override get isReady(): boolean {
    return this._data.length > 0;
  }
}
