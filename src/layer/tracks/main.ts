/**
 * TracksLayer - Time-aware track visualization
 *
 * Renders particle/cell tracks as line segments with temporal tail fading.
 * Each track is a sequence of (trackId, time, position) points, rendered as
 * connected line segments that fade in alpha based on temporal distance
 * from the current time.
 *
 * Matches napari's Tracks layer for visualizing object trajectories
 * over time in volumetric datasets.
 */

import type { LayerConfig, Vec3 } from "../../types";
import { EMPTY_VERTEX_BUFFER, optArray, optNumber, optVec3 } from "../../utils";
import {
  BaseLayer,
  MIN_VEC4_BUFFER,
  type Geometry,
  type LayerParams,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// TRACKS TYPES
// ============================================================================

export interface TrackPoint {
  trackId  : number;
  t        : number;
  position : Vec3;
}

export interface TracksConfig {
  /** Array of track points */
  tracks?      : TrackPoint[];
  /** Current time for tail visibility */
  currentTime? : number;
  /** Number of time units visible in the tail (default: 10) */
  tailLength?  : number;
  /** Line width (default: 1) */
  tailWidth?   : number;
  /** Display color (RGB, 0-1) */
  color?       : Vec3;
  /** Opacity (0-1) */
  opacity?     : number;
  /** Lineage graph: { trackId: [parentIds] } */
  graph?       : Record<number, number[]>;
}

/** Options accepted in `LayerConfig.options` for {@link TracksLayer}. */
export type TracksOptions = TracksConfig;

/** `LayerConfig` with the tracks layer's typed options bag. */
export type TracksLayerConfig = LayerConfig<TracksOptions>;

// ============================================================================
// TRACKS PARAMETERS
// ============================================================================

export class TracksLayerParams implements LayerParams {
  color: Vec3  = [0.0, 1.0, 0.5];
  opacity      = 1.0;
  currentTime  = 0;
  tailLength   = 10;
  tailWidth    = 1;

  constructor(config?: TracksConfig) {
    if (config?.color) this.color = config.color;
    if (config?.opacity !== undefined) this.opacity = config.opacity;
    if (config?.currentTime !== undefined) this.currentTime = config.currentTime;
    if (config?.tailLength !== undefined) this.tailLength = config.tailLength;
    if (config?.tailWidth !== undefined) this.tailWidth = config.tailWidth;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  // Layout: color(3f) + opacity(1f) + current_time(1f) + tail_length(1f) + tail_width(1f) + _pad(1f) = 8 floats = 32 bytes
  private readonly _buffer = new Float32Array(8);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0] = this.color[0];
    b[1] = this.color[1];
    b[2] = this.color[2];
    b[3] = this.opacity;
    b[4] = this.currentTime;
    b[5] = this.tailLength;
    b[6] = this.tailWidth;
    return b;
  }
}

// ============================================================================
// TRACKS LAYER
// ============================================================================

export class TracksLayer extends BaseLayer {
  static readonly layerType = "tracks";
  static fromConfig(id: string, desc: TracksLayerConfig): TracksLayer {
    const opts = desc.options ?? {};
    return new TracksLayer(id, {
      tracks      : optArray(opts.tracks, optTrackPoint),
      currentTime : optNumber(opts.currentTime),
      tailLength  : optNumber(opts.tailLength),
      tailWidth   : optNumber(opts.tailWidth),
      color       : optVec3(opts.color),
      opacity     : optNumber(opts.opacity),
      graph       : optGraph(opts.graph),
    });
  }
  protected override shaderCode = shaderCode;
  private params      : TracksLayerParams;
  private _tracks     : TrackPoint[] = [];
  private _graph      : Record<number, number[]> = {};
  /** GPU buffer: line-list vertices as vec4f(x, y, z, time) */
  private _gpuBuffer  : Float32Array = MIN_VEC4_BUFFER;
  /** Number of line vertices (2 per segment) */
  private _vertexCount = 0;

  constructor(id?: string, config?: TracksConfig) {
    super(id);
    this.params  = new TracksLayerParams(config);
    this.opacity = this.params.opacity;
    if (config?.tracks) {
      this._tracks = [...config.tracks];
    }
    if (config?.graph) {
      this._graph = { ...config.graph };
    }
    this.rebuildBuffer();
  }

  /** Get current track points */
  get tracks(): readonly TrackPoint[] {
    return this._tracks;
  }

  /** Set current time (controls tail visibility window) */
  setTime(t: number): void {
    this.params.currentTime = t;
  }

  /** Get current time */
  get currentTime(): number {
    return this.params.currentTime;
  }

  /** Replace all track data */
  setTracks(tracks: TrackPoint[]): void {
    this._tracks = tracks.map(p => ({
      trackId   : p.trackId,
      t         : p.t,
      position  : [...p.position] as Vec3,
    }));
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Set lineage graph */
  setGraph(graph: Record<number, number[]>): void {
    this._graph = { ...graph };
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Set display color */
  setColor(color: Vec3): void {
    this.params.color = color;
  }

  /** Set tail length (time units) */
  setTailLength(length: number): void {
    this.params.tailLength = length;
  }

  /**
   * Build GPU buffer: line-list format.
   * For each track, sort points by time and emit line segments between
   * consecutive points. Also add graph edges (parent→child connections).
   */
  private rebuildBuffer(): void {
    if (this._tracks.length === 0) {
      this._gpuBuffer   = MIN_VEC4_BUFFER;
      this._vertexCount = 0;
      return;
    }

    // Group points by trackId
    const byTrack = new Map<number, TrackPoint[]>();
    for (const pt of this._tracks) {
      let arr = byTrack.get(pt.trackId);
      if (!arr) {
        arr = [];
        byTrack.set(pt.trackId, arr);
      }
      arr.push(pt);
    }

    // Sort each track by time
    for (const pts of byTrack.values()) {
      pts.sort((a, b) => a.t - b.t);
    }

    // Count line segments: (points-1) per track + graph edges
    let segCount = 0;
    for (const pts of byTrack.values()) {
      segCount += Math.max(0, pts.length - 1);
    }

    // Count graph edge segments
    const graphEdges: [TrackPoint, TrackPoint][] = [];
    for (const [childId, parentIds] of Object.entries(this._graph)) {
      const childPts = byTrack.get(Number(childId));
      if (!childPts || childPts.length === 0) continue;
      const childStart = childPts[0];
      for (const parentId of parentIds) {
        const parentPts = byTrack.get(parentId);
        if (!parentPts || parentPts.length === 0) continue;
        const parentEnd = parentPts[parentPts.length - 1];
        graphEdges.push([parentEnd, childStart]);
        segCount++;
      }
    }

    // Build line-list: 2 vertices (vec4f each) per segment
    const buf = new Float32Array(segCount * 2 * 4);
    let offset = 0;

    for (const pts of byTrack.values()) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        buf[offset++] = a.position[0];
        buf[offset++] = a.position[1];
        buf[offset++] = a.position[2];
        buf[offset++] = a.t;
        buf[offset++] = b.position[0];
        buf[offset++] = b.position[1];
        buf[offset++] = b.position[2];
        buf[offset++] = b.t;
      }
    }

    // Graph edges
    for (const [parent, child] of graphEdges) {
      buf[offset++] = parent.position[0];
      buf[offset++] = parent.position[1];
      buf[offset++] = parent.position[2];
      buf[offset++] = parent.t;
      buf[offset++] = child.position[0];
      buf[offset++] = child.position[1];
      buf[offset++] = child.position[2];
      buf[offset++] = child.t;
    }

    this._gpuBuffer   = buf;
    this._vertexCount = segCount * 2;
  }

  // === BaseLayer interface ===

  getGeometry(): Geometry {
    return {
      vertices      : EMPTY_VERTEX_BUFFER,
      vertexCount   : this._vertexCount,
      vertexStride  : 4,
      vertexFormat  : "float32",
      topology      : "line-list",
      instanceCount : 1,
    };
  }

  protected getLayerParams(): LayerParams {
    return this.params;
  }

  override getStorageData(): { data: Float32Array; label?: string } | null {
    return { data: this._gpuBuffer, label: `Tracks ${this.id} Data` };
  }
}

/** Structural check for one track point: numeric trackId/time + Vec3 position. */
function optTrackPoint(value: unknown): TrackPoint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<TrackPoint>;
  const trackId   = optNumber(candidate.trackId);
  const t         = optNumber(candidate.t);
  const position  = optVec3(candidate.position);
  return trackId !== undefined && t !== undefined && position
    ? { trackId, t, position }
    : undefined;
}

/** Structural check for the lineage graph: numeric keys, number-array values. */
function optGraph(value: unknown): Record<number, number[]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<number, number[]> = {};
  for (const [key, parents] of Object.entries(value)) {
    const ids = optArray(parents, optNumber);
    if (!ids) return undefined;
    out[Number(key)] = ids;
  }
  return out;
}
