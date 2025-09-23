/**
 * PlanesLayer - Glass-feel orientation planes
 *
 * Renders 3 semi-transparent planes (XY, XZ, YZ) showing current slice positions.
 * Each plane is centered on the surface but positioned along its normal axis
 * based on the slice target position.
 *
 * Color conventions:
 * - XY plane (Z-normal): Blue - moves along Z based on sliceTarget.z
 * - XZ plane (Y-normal): Green - moves along Y based on sliceTarget.y
 * - YZ plane (X-normal): Red - moves along X based on sliceTarget.x
 */

import type { Vec3 } from "../../types";
import {
  BaseLayer,
  type Geometry,
  type LayerParams,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// === Configuration ===

export interface PlanesConfig {
  /** Surface center - where planes are centered in-plane */
  surfaceCenter? : Vec3;
  /** Slice target - where each plane is positioned along its normal axis */
  sliceTarget?   : Vec3;
  /** Half-size of each plane (default: 0.3 in normalized space) */
  size?          : number;
  /** Base opacity for glass effect (default: 0.18) */
  opacity?       : number;
}

// === Parameters ===

export class PlanesLayerParams implements LayerParams {
  /** Surface center - planes are centered here for in-plane axes */
  surfaceCenter : Vec3 = [0.5, 0.5, 0.5];
  /** Slice target - each plane moves along its normal to this position */
  sliceTarget   : Vec3 = [0.5, 0.5, 0.5];
  size                 = 0.12;
  opacity              = 0.25;

  constructor(config: PlanesConfig = {}) {
    if (config.surfaceCenter) this.surfaceCenter = config.surfaceCenter;
    if (config.sliceTarget) this.sliceTarget = config.sliceTarget;
    if (config.size !== undefined) this.size = config.size;
    if (config.opacity !== undefined) this.opacity = config.opacity;
  }

  setSurfaceCenter(center: Vec3): void {
    this.surfaceCenter = center;
  }

  setSliceTarget(target: Vec3): void {
    this.sliceTarget = target;
  }

  setSize(size: number): void {
    this.size = size;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  // Layout matches shader PlaneParams struct:
  // surfaceCenter(3f) + size(1f) + sliceTarget(3f) + opacity(1f) = 8 floats = 32 bytes
  private readonly _buffer = new Float32Array(8);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0] = this.surfaceCenter[0];
    b[1] = this.surfaceCenter[1];
    b[2] = this.surfaceCenter[2];
    b[3] = this.size;
    b[4] = this.sliceTarget[0];
    b[5] = this.sliceTarget[1];
    b[6] = this.sliceTarget[2];
    b[7] = this.opacity;
    return b;
  }
}

// === Geometry Generation ===

/**
 * Create vertex data for 3 axis-aligned planes.
 * Each plane is a quad with 6 vertices (2 triangles).
 * Vertex format: [x, y, z, plane_id] per vertex
 */
function createPlanesGeometry(): Float32Array {
  const vertices: number[] = [];

  // Quad corners in local space [-1, 1]
  const quadPositions = [
    [-1, -1], [1, -1], [1, 1],
    [-1, -1], [1, 1], [-1, 1],
  ];

  // Create 3 planes
  for (let planeId = 0; planeId < 3; planeId++) {
    for (const [lx, ly] of quadPositions) {
      // Local position (will be transformed in shader)
      vertices.push(lx, ly, 0, planeId);
    }
  }

  return new Float32Array(vertices);
}

// === Planes Data ===

export class PlanesLayer extends BaseLayer {
  protected override shaderCode = shaderCode;

  private params    : PlanesLayerParams;
  private vertices  : Float32Array;

  constructor(id?: string, config?: PlanesConfig) {
    super(id);
    this.params   = new PlanesLayerParams(config);
    this.opacity  = this.params.opacity;
    this.vertices = createPlanesGeometry();
  }

  /** Planes shader transforms geometry locally; no model uniform needed. */
  override getShader() {
    return {
      ...super.getShader(),
      bindings: { model: false },
    };
  }

  /** Set surface center - planes are centered here for in-plane axes */
  setSurfaceCenter(center: Vec3): void {
    this.params.setSurfaceCenter(center);
  }

  /** Set slice target - each plane moves along its normal to this position */
  setSliceTarget(target: Vec3): void {
    this.params.setSliceTarget(target);
  }

  /** Update plane size */
  setSize(size: number): void {
    this.params.setSize(size);
  }

  /** Update opacity */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  getGeometry(): Geometry {
    return {
      vertices      : this.vertices,
      vertexCount   : 18, // 3 planes × 6 vertices
      vertexStride  : 16, // 4 floats × 4 bytes
      vertexFormat  : "float32x4",
      topology      : "triangle-list",
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },  // position
        { shaderLocation: 1, offset: 12, format: "float32" },   // plane_id
      ],
    };
  }

  getParams(): LayerParams {
    this.params.setOpacity(this.opacity);
    return this.params;
  }
}
