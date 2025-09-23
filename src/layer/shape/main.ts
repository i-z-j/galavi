/**
 * ShapesLayer - 2D shapes rendering
 *
 * Renders closed polygon outlines on slice views for region visualization.
 * Each shape entry consists of vertex positions (XY pairs) and optional
 * tangent vectors (left/right) per vertex for smooth curve reconstruction.
 *
 * Matches napari's Shapes layer. Also supports DICOM RT Structure Set
 * shape outlines, where regions of interest are defined as closed planar polygons per slice.
 */

import { vec3 } from "wgpu-matrix";
import type {
  Data,
  LayerConfig,
  State,
  Vec3,
} from "../../types";
import {
  resolveAxes,
  resolveDataUrl,
  sourceChanged,
  type AxisMap,
} from "../../utils";
import {
  BaseLayer,
  type Geometry,
  type LayerParams,
} from "../base";
// Direct sibling-file import (not via the `../` barrel) to avoid a cycle:
// `layer/index.ts` re-exports both ShapeLayer and SurfaceLayer.
import { SurfaceLayer } from "../surface/main";
import { intersectSurfaceWithPlane } from "./intersect";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// SHAPES TYPES
// ============================================================================

/** A single shape entry */
export interface ShapeEntry {
  /** Vertex positions as [x, y] pairs in normalized [0,1]² space */
  vertices      : [number, number][];
  /** Optional left tangent vectors per vertex (for Bezier/Hermite curves) */
  tangentLeft?  : [number, number][];
  /** Optional right tangent vectors per vertex (for Bezier/Hermite curves) */
  tangentRight? : [number, number][];
  /** Optional label for this shape */
  label?        : string;
  /** Optional per-entry color override */
  color?        : Vec3;
}

/** Shapes configuration */
export interface ShapesConfig {
  /** Color of the shape outline (RGB, 0-1) */
  color?           : Vec3;
  /** Opacity of the shape outline (0-1) */
  opacity?         : number;
  /** Shape entries */
  entries?         : ShapeEntry[];
  /** Data volume size for coordinate normalization */
  dataSize?        : Vec3;
  /**
  * ID of a SurfaceLayer entry whose geometry drives these shapes.
  * When set, entries are computed dynamically via surface-plane intersection
   * rather than being user-supplied. Explorer handles the computation.
   * Used as fallback when source urlTemplate fetch fails.
   */
  surfaceSourceId? : string;
  /**
   * Data source for dynamic 2D shape boundary fetching.
   * urlTemplate placeholders: {axis}, {slicePos}.
   * When provided, Explorer fetches shapes via this source first;
   * on failure it falls back to surfaceSourceId-based intersection.
   */
  source?          : Data;
}

// ============================================================================
// SHAPES PARAMETERS
// ============================================================================

export class ShapesLayerParams implements LayerParams {
  color: Vec3 = [1.0, 0.3, 0.3];
  opacity     = 1.0;

  constructor(config?: ShapesConfig) {
    if (config?.color) this.color = config.color;
    if (config?.opacity !== undefined) this.opacity = config.opacity;
  }

  setColor(color: Vec3): void {
    this.color = color;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  // Layout matches shader Params struct:
  // color(3f) + opacity(1f) = 4 floats = 16 bytes
  private readonly _buffer = new Float32Array(4);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0] = this.color[0];
    b[1] = this.color[1];
    b[2] = this.color[2];
    b[3] = this.opacity;
    return b;
  }
}

// ============================================================================
// SHAPES LAYER
// ============================================================================

export class ShapesLayer extends BaseLayer {
  static readonly layerType = "shapes";
  static fromConfig(id: string, desc: LayerConfig): ShapesLayer {
    return new ShapesLayer(id, {
      color           : (desc.options?.color as Vec3) ?? undefined,
      opacity         : desc.options?.opacity as number | undefined,
      entries         : desc.options?.entries as ShapeEntry[] | undefined,
      dataSize        : (desc.options?.dataSize as Vec3) ?? undefined,
      surfaceSourceId : desc.options?.surfaceSourceId as string | undefined,
      source          : desc.data,
    });
  }
  protected override shaderCode = shaderCode;
  private params            : ShapesLayerParams;
  private entries           : ShapeEntry[];
  private _vertices?        : Float32Array;
  private _surfaceSourceId? : string;
  private _source?          : Data;

  constructor(id?: string, config?: ShapesConfig) {
    super(id);
    this.params           = new ShapesLayerParams(config);
    this.opacity          = this.params.opacity;
    this._surfaceSourceId = config?.surfaceSourceId;
    this._source          = config?.source;
    // If driven by a source or surface, start with no entries (computed dynamically)
    const isDynamic = !!this._surfaceSourceId || !!this._source;
    this.entries = isDynamic ? [] : (config?.entries ?? []);
    this.buildVertices();
  }

  /** Get the surface source ID if these shapes are dynamically derived */
  get surfaceSourceId(): string | undefined {
    return this._surfaceSourceId;
  }

  /** Get the data source for dynamic shape fetching */
  get source(): Data | undefined {
    return this._source;
  }

  /**
   * Update the data source (e.g. when the URL changes).
   * Compares URLs to detect actual changes.
   */
  override setSource(source: Data): void {
    if (!sourceChanged(source, this._source)) return;
    this._source = source;
    this._sourceVersion++;
  }

  /** Version counter — incremented on setSource so explorer can invalidate cache */
  private _sourceVersion = 0;
  get sourceVersion(): number { return this._sourceVersion; }

  /**
   * Fetch shape entries from the source urlTemplate.
   * Placeholders: {axis}, {slicePos} are substituted by the library.
   * Returns parsed entries on success, or null on failure.
   */
  async fetchFromSource(axis: string, slicePos: number): Promise<ShapeEntry[] | null> {
    if (!this._source) return null;

    try {
      const url = resolveDataUrl(this._source, { axis, slicePos });
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json = await resp.json();
      // Expect JSON array of ShapeEntry-like objects
      if (Array.isArray(json)) return json as ShapeEntry[];
      return null;
    } catch {
      return null;
    }
  }

  /** Update shape entries and rebuild geometry */
  setEntries(entries: ShapeEntry[]): void {
    this.entries    = entries;
    this._vertices  = undefined;
    this.buildVertices();
    this.geometryVersion++;
  }

  /** Get current shape entries */
  getEntries(): readonly ShapeEntry[] {
    return this.entries;
  }

  /** Build flat vertex array from all entries (closed polygons as line-list) */
  private buildVertices(): void {
    // Build explicit edge segments per shape:
    // [v0,v1], [v1,v2], ... [vn-2,vn-1], [vn-1,v0]
    // This avoids accidental bridge lines between separate entries.
    const allVerts: number[] = [];

    for (const entry of this.entries) {
      if (entry.vertices.length < 2) continue;

      const verts = entry.vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        allVerts.push(a[0], a[1], b[0], b[1]);
      }
    }

    this._vertices = new Float32Array(allVerts);
  }

  getGeometry(): Geometry {
    const hasVertices = !!this._vertices && this._vertices.length > 0;
    const vertices = hasVertices ? this._vertices! : new Float32Array([0, 0]);

    return {
      vertices,
      vertexCount   : hasVertices ? (vertices.length / 2) : 0,
      vertexStride  : 8, // 2 floats × 4 bytes
      vertexFormat  : "float32x2",
      topology      : "line-list",
    };
  }

  getParams(): LayerParams {
    this.params.setOpacity(this.opacity);
    return this.params;
  }

  // === Config & Slice Update ===

  protected override applyDataSource(desc: LayerConfig): void {
    super.applyDataSource(desc);
    if (desc.data) {
      const sv = this.sourceVersion;
      if (this._lastSourceVersion !== undefined && this._lastSourceVersion !== sv) {
        this._sliceCache = undefined; // invalidate cache on source change
      }
      this._lastSourceVersion = sv;
    }
  }

  private _sliceCache?        : number;
  private _lastSourceVersion? : number;

  private static readonly AXIS_NAMES = ["x", "y", "z"];

  /**
   * Recompute shape entries for the current slice plane.
   * Resolves `surfaceSourceId` against sibling layers.
   */
  override prepareFrame(
    state     : State,
    siblings  : Map<string, { desc: LayerConfig; layer: BaseLayer }>,
  ): void {
    const cameraTarget    = state.exploration.camera.target;
    const hasSource       = !!this._source;
    const surfaceSourceId = this._surfaceSourceId;
    if (!hasSource && !surfaceSourceId) return;

    // We need options.axes from our own config to know the slice orientation.
    // Retrieve from the siblings map using our own id.
    const self = siblings.get(this.id);
    if (!self?.desc.options) return;

    const axes = self.desc.options.axes as (string | number)[] | undefined;
    if (!axes || axes.length < 2) return;

    const axisMap   = resolveAxes(axes);
    const sliceAxis = axisMap[2];
    const axisName  = ShapesLayer.AXIS_NAMES[sliceAxis] ?? String(sliceAxis);

    const surfaceLayer  = surfaceSourceId ? siblings.get(surfaceSourceId)?.layer : undefined;
    const surfaceAabb   = isSurfaceLayer(surfaceLayer) ? surfaceLayer.aabb : undefined;

    // Derive transform from surface model matrix
    if (surfaceLayer) {
      const ms = surfaceLayer.modelMatrix;
      const scaleForAxis = (axis: number) => ms[axis * 5];
      this.setTransform({ scale: [scaleForAxis(axisMap[0]), scaleForAxis(axisMap[1]), 1] });
    }

    const targetLocal: Vec3 = surfaceLayer
      ? (Array.from(
          vec3.transformMat4(cameraTarget, surfaceLayer.invModelMatrix),
        ) as Vec3)
      : cameraTarget;
    const targetNorm = targetLocal[sliceAxis];
    const slicePos = (() => {
      if (!surfaceAabb) return targetNorm;
      const min   = surfaceAabb.min[sliceAxis];
      const max   = surfaceAabb.max[sliceAxis];
      const range = max - min;
      if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(range) < 1e-12) {
        return targetNorm;
      }
      return min + targetNorm * range;
    })();

    // Dedup: skip if slice position hasn't changed
    if (this._sliceCache !== undefined && Math.abs(this._sliceCache - slicePos) < 1e-7) {
      return;
    }
    this._sliceCache = slicePos;

    if (hasSource) {
      this.fetchFromSource(axisName, slicePos).then((fetched) => {
        if (fetched && fetched.length > 0) {
          this.setEntries(fetched);
          this.requestRender();
          return;
        }
        if (this.fallbackIntersection(surfaceLayer, surfaceAabb, sliceAxis, slicePos, axisMap)) {
          this.requestRender();
        } else {
          this._sliceCache = undefined;
        }
      });
      return;
    }

    if (!this.fallbackIntersection(surfaceLayer, surfaceAabb, sliceAxis, slicePos, axisMap)) {
      this._sliceCache = undefined;
    }
  }

  private fallbackIntersection(
    surfaceLayer  : BaseLayer | undefined,
    surfaceAabb   : { min: Vec3; max: Vec3 } | undefined,
    sliceAxis     : number,
    slicePos      : number,
    axisMap       : AxisMap,
  ): boolean {
    if (!isSurfaceLayer(surfaceLayer)) return false;
    const positions = surfaceLayer.getPositions();
    if (!positions || positions.length === 0) return false;

    const entries = intersectSurfaceWithPlane(positions, sliceAxis, slicePos, axisMap);

    if (surfaceAabb) {
      const uAxis   = axisMap[0];
      const vAxis   = axisMap[1];
      const uMin    = surfaceAabb.min[uAxis];
      const uMax    = surfaceAabb.max[uAxis];
      const vMin    = surfaceAabb.min[vAxis];
      const vMax    = surfaceAabb.max[vAxis];
      const uRange  = Math.abs(uMax - uMin) > 1e-12 ? (uMax - uMin) : 1;
      const vRange  = Math.abs(vMax - vMin) > 1e-12 ? (vMax - vMin) : 1;

      const normalizedEntries = entries.map((entry) => ({
        ...entry,
        vertices: entry.vertices.map(([u, v]) => [
          Math.max(0, Math.min(1, (u - uMin) / uRange)),
          Math.max(0, Math.min(1, (v - vMin) / vRange)),
        ] as [number, number]),
      }));
      this.setEntries(normalizedEntries);
    } else {
      this.setEntries(entries);
    }
    return true;
  }
}

function isSurfaceLayer(layer?: BaseLayer): layer is SurfaceLayer {
  return layer instanceof SurfaceLayer;
}
