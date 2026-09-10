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
} from "../../../state/schema";
import {
  dataSourceChanged,
  optArray,
  optAxis,
  optNumber,
  optString,
  optVec2,
  optVec3,
  resolveAxes,
  resolveDataUrl,
  type AxisMap,
} from "../../../utils";
import {
  BaseLayer,
  type Geometry,
  type LayerParams,
} from "../base";
// Direct sibling-file import (not via the `../` barrel) to avoid a cycle:
// `layer/index.ts` re-exports both ShapeLayer and SurfaceLayer.
import { SurfaceLayer } from "../surface/main";
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

/**
 * Options accepted in `LayerConfig.options` for {@link ShapesLayer}.
 * Adds `axes` (read at frame time for surface-intersection shapes), which the
 * constructor config does not take.
 */
export interface ShapesOptions extends Omit<ShapesConfig, "source"> {
  /** Slice-plane axes [u, v] for surface-intersection shapes */
  axes? : (string | number)[];
}

/** `LayerConfig` with the shapes layer's typed options bag. */
export type ShapesLayerConfig = LayerConfig<ShapesOptions>;

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
  static fromConfig(id: string, desc: ShapesLayerConfig): ShapesLayer {
    const opts = desc.options ?? {};
    return new ShapesLayer(id, {
      color           : optVec3(opts.color),
      opacity         : optNumber(opts.opacity),
      entries         : optArray(opts.entries, optShapeEntry),
      dataSize        : optVec3(opts.dataSize),
      surfaceSourceId : optString(opts.surfaceSourceId),
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
    if (!dataSourceChanged(source, this._source)) return;
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

  protected getLayerParams(): LayerParams {
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

    const axes = optArray(self.desc.options.axes, optAxis);
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

/** Minimal structural check: an entry must at least carry [x,y] vertex pairs. */
function optShapeEntry(value: unknown): ShapeEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const vertices = optArray((value as ShapeEntry).vertices, optVec2);
  return vertices ? { ...(value as ShapeEntry), vertices } : undefined;
}

// ============================================================================
// SURFACE-PLANE INTERSECTION (internal — exported only for focused tests;
// not re-exported from primitives/layer/index.ts or the package root)
// ============================================================================
//
// Computes the intersection of a triangle surface with an axis-aligned plane,
// producing 2D shape entries suitable for ShapesLayer rendering.
//
// Algorithm:
// 1. For each triangle, check which edges cross the plane (axis = position).
// 2. Collect the two intersection points per crossing triangle (a plane
//    intersects a triangle in exactly 0 or 2 edge crossings, ignoring
//    degenerate tangent cases).
// 3. Project intersection points to 2D via the slice's axisMap.
// 4. Chain connected segments into closed shapes where possible.
//
// All coordinates are in normalized [0,1]³ / [0,1]² space.

/** A 2D line segment from the surface-plane intersection */
interface Segment {
  a: [number, number];
  b: [number, number];
}

/**
 * Intersect a triangle surface with an axis-aligned plane.
 *
 * @param positions  - Float32Array of vertex positions (x,y,z triples), normalized [0,1]³
 * @param sliceAxis  - Which axis the plane is perpendicular to (0=X, 1=Y, 2=Z)
 * @param slicePos   - Position along sliceAxis in [0,1]
 * @param axisMap    - [uAxis, vAxis, sliceAxis] mapping 3D → 2D
 * @param tolerance  - Half-thickness of the slab for capturing near-plane triangles (default: 0.001)
 * @returns ShapeEntry[] — closed shapes in [0,1]² slice space
 */
export function intersectSurfaceWithPlane(
  positions : Float32Array,
  sliceAxis : number,
  slicePos  : number,
  axisMap   : AxisMap,
  tolerance = 0.001,
): ShapeEntry[] {
  const uAxis = axisMap[0];
  const vAxis = axisMap[1];
  const segments: Segment[] = [];

  const triCount = Math.floor(positions.length / 9); // 3 verts × 3 floats

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;

    // Triangle vertices along slice axis
    const a0 = positions[base + sliceAxis];
    const a1 = positions[base + 3 + sliceAxis];
    const a2 = positions[base + 6 + sliceAxis];

    // Signed distances from the plane
    const d0 = a0 - slicePos;
    const d1 = a1 - slicePos;
    const d2 = a2 - slicePos;

    // Quick reject: all on same side and beyond tolerance
    if (d0 > tolerance && d1 > tolerance && d2 > tolerance) continue;
    if (d0 < -tolerance && d1 < -tolerance && d2 < -tolerance) continue;

    // Collect intersection points from edges crossing the plane
    const pts: [number, number][] = [];

    collectEdgeIntersection(positions, base, 0, 3, uAxis, vAxis, d0, d1, pts);
    collectEdgeIntersection(positions, base, 3, 6, uAxis, vAxis, d1, d2, pts);
    collectEdgeIntersection(positions, base, 6, 0, uAxis, vAxis, d2, d0, pts);

    if (pts.length >= 2) {
      segments.push({ a: pts[0], b: pts[1] });
    }
  }

  if (segments.length === 0) return [];

  // Chain segments into closed shapes
  return chainSegments(segments);
}

/**
 * Check if an edge crosses the plane; if so, compute the 2D intersection point.
 */
function collectEdgeIntersection(
  positions   : Float32Array,
  base        : number,
  offsetA     : number,
  offsetB     : number,
  uAxis       : number,
  vAxis       : number,
  dA          : number,
  dB          : number,
  pts         : [number, number][],
): void {
  // Edge crosses plane if signs differ (one positive, one negative)
  // Also handle vertex exactly on the plane
  if ((dA > 0 && dB > 0) || (dA < 0 && dB < 0)) return;

  // Both on plane — skip (degenerate, coplanar edge)
  if (dA === 0 && dB === 0) return;

  // Interpolation parameter
  const t = dA / (dA - dB);

  const iA = base + offsetA;
  const iB = base + offsetB;

  const u = positions[iA + uAxis] + t * (positions[iB + uAxis] - positions[iA + uAxis]);
  const v = positions[iA + vAxis] + t * (positions[iB + vAxis] - positions[iA + vAxis]);

  pts.push([u, v]);
}

// === Segment chaining ===

/** Spatial hashing precision for connecting nearby endpoints */
const HASH_PRECISION = 1e5;

function hashPoint(p: [number, number]): string {
  return `${Math.round(p[0] * HASH_PRECISION)},${Math.round(p[1] * HASH_PRECISION)}`;
}

/**
 * Chain line segments into closed shapes.
 *
 * Uses an adjacency-based approach: build a map from endpoint → connected segments,
 * then walk chains greedily. Produces ShapeEntry[] with each entry being a
 * closed (or open) polyline.
 */
function chainSegments(segments: Segment[]): ShapeEntry[] {
  if (segments.length === 0) return [];

  // Build adjacency: endpoint hash → list of segment indices
  const adj = new Map<string, number[]>();
  const used = new Uint8Array(segments.length);

  for (let i = 0; i < segments.length; i++) {
    const hA = hashPoint(segments[i].a);
    const hB = hashPoint(segments[i].b);

    if (!adj.has(hA)) adj.set(hA, []);
    adj.get(hA)!.push(i);

    if (!adj.has(hB)) adj.set(hB, []);
    adj.get(hB)!.push(i);
  }

  const entries: ShapeEntry[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;

    // Start a new chain from this segment
    const chain: [number, number][] = [segments[i].a, segments[i].b];
    used[i] = 1;

    // Extend forward from chain end
    let extended = true;
    while (extended) {
      extended = false;
      const endHash = hashPoint(chain[chain.length - 1]);
      const neighbors = adj.get(endHash);
      if (!neighbors) break;

      for (const ni of neighbors) {
        if (used[ni]) continue;
        used[ni] = 1;
        const seg = segments[ni];

        // Which end connects?
        const hA = hashPoint(seg.a);
        if (hA === endHash) {
          chain.push(seg.b);
        } else {
          chain.push(seg.a);
        }
        extended = true;
        break;
      }
    }

    // Extend backward from chain start
    extended = true;
    while (extended) {
      extended = false;
      const startHash = hashPoint(chain[0]);
      const neighbors = adj.get(startHash);
      if (!neighbors) break;

      for (const ni of neighbors) {
        if (used[ni]) continue;
        used[ni] = 1;
        const seg = segments[ni];

        const hA = hashPoint(seg.a);
        if (hA === startHash) {
          chain.unshift(seg.b);
        } else {
          chain.unshift(seg.a);
        }
        extended = true;
        break;
      }
    }

    // Only emit shape outlines with enough points
    if (chain.length >= 3) {
      entries.push({ vertices: chain });
    }
  }

  return entries;
}
