/**
 * NetworkLayer - Graph/network visualization (nodes + edges)
 *
 * Renders a graph as 3D billboard circles for nodes and line segments
 * for edges. Uses a two-pass approach: edges first (line-list), then
 * nodes (instanced quads like PointsLayer).
 *
 * No napari equivalent — galavi-specific layer for connectome,
 * spatial graph, and network data.
 */

import type { LayerConfig, Vec3 } from "../../types";
import { EMPTY_VERTEX_BUFFER } from "../../utils";
import {
  BaseLayer,
  type LayerParams,
  type Geometry,
  type Shader,
  MIN_VEC4_BUFFER,
} from "../base";
import shaderCode from "./shader.wgsl?raw";

// ============================================================================
// NETWORK TYPES
// ============================================================================

export interface NetworkConfig {
  /** Node positions in 3D space */
  nodes?      : Vec3[];
  /** Edges as [fromIndex, toIndex] pairs */
  edges?      : [number, number][];
  /** Node display size (default: 0.01) */
  nodeSize?   : number;
  /** Node color (RGB, 0-1) */
  nodeColor?  : Vec3;
  /** Edge color (RGB, 0-1) */
  edgeColor?  : Vec3;
  /** Edge line width (default: 1) */
  edgeWidth?  : number;
  /** Opacity (0-1) */
  opacity?    : number;
}

// ============================================================================
// NETWORK PARAMETERS
// ============================================================================

export class NetworkLayerParams implements LayerParams {
  nodeColor : Vec3 = [0.2, 0.6, 1.0];
  edgeColor : Vec3 = [0.7, 0.7, 0.7];
  nodeSize        = 0.01;
  opacity         = 1.0;
  nodeCount       = 0;
  edgeVertexCount = 0;
  mode            = 0; // 0 = edges, 1 = nodes (set per render pass)

  constructor(config?: NetworkConfig) {
    if (config?.nodeColor) this.nodeColor = config.nodeColor;
    if (config?.nodeSize !== undefined) this.nodeSize = config.nodeSize;
    if (config?.edgeColor) this.edgeColor = config.edgeColor;
    if (config?.opacity !== undefined) this.opacity = config.opacity;
  }

  // Layout: node_color(3f) + node_size(1f) + edge_color(3f) + opacity(1f)
  //       + node_count(1u) + edge_vcount(1u) + mode(1u) + _pad(1u) = 12 × 4 = 48 bytes
  private readonly _buffer    = new Float32Array(12);
  private readonly _bufferU32 = new Uint32Array(this._buffer.buffer);
  toBuffer(): Float32Array {
    const b = this._buffer;
    b[0]  = this.nodeColor[0];
    b[1]  = this.nodeColor[1];
    b[2]  = this.nodeColor[2];
    b[3]  = this.nodeSize;
    b[4]  = this.edgeColor[0];
    b[5]  = this.edgeColor[1];
    b[6]  = this.edgeColor[2];
    b[7]  = this.opacity;
    this._bufferU32[8]  = this.nodeCount;
    this._bufferU32[9]  = this.edgeVertexCount;
    this._bufferU32[10] = this.mode;
    this._bufferU32[11] = 0;
    return b;
  }
}

// ============================================================================
// NETWORK LAYER
// ============================================================================

export class NetworkLayer extends BaseLayer {
  static readonly layerType = "network";
  static fromConfig(id: string, desc: LayerConfig): NetworkLayer {
    return new NetworkLayer(id, {
      nodes     : (desc.options?.nodes as Vec3[]) ?? undefined,
      edges     : desc.options?.edges as [number, number][] | undefined,
      nodeSize  : desc.options?.nodeSize as number | undefined,
      nodeColor : (desc.options?.nodeColor as Vec3) ?? undefined,
      edgeColor : (desc.options?.edgeColor as Vec3) ?? undefined,
      edgeWidth : desc.options?.edgeWidth as number | undefined,
      opacity   : desc.options?.opacity as number | undefined,
    });
  }
  private params      : NetworkLayerParams;
  private _nodes      : Vec3[] = [];
  private _edges      : [number, number][] = [];
  /** Combined GPU buffer: [nodePositions...] [edgeVertexPositions...] */
  private _gpuBuffer  : Float32Array = MIN_VEC4_BUFFER;

  constructor(id?: string, config?: NetworkConfig) {
    super(id);
    this.params = new NetworkLayerParams(config);
    if (config?.nodes) this._nodes = config.nodes.map(n => [...n] as Vec3);
    if (config?.edges) this._edges = config.edges.map(e => [...e] as [number, number]);
    this.rebuildBuffer();
  }

  /** Get node positions */
  get nodes(): readonly Vec3[] {
    return this._nodes;
  }

  /** Get edge pairs */
  get edges(): readonly [number, number][] {
    return this._edges;
  }

  /** Replace all nodes */
  setNodes(nodes: Vec3[]): void {
    this._nodes = nodes.map(n => [...n] as Vec3);
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Replace all edges */
  setEdges(edges: [number, number][]): void {
    this._edges = edges.map(e => [...e] as [number, number]);
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Add a node, returns its index */
  addNode(position: Vec3): number {
    this._nodes.push([...position] as Vec3);
    this.rebuildBuffer();
    this.geometryVersion++;
    return this._nodes.length - 1;
  }

  /** Remove a node by index (also removes connected edges) */
  removeNode(index: number): void {
    if (index < 0 || index >= this._nodes.length) return;
    this._nodes.splice(index, 1);
    // Remove edges referencing this node, and adjust indices
    this._edges = this._edges
      .filter(([a, b]) => a !== index && b !== index)
      .map(([a, b]) => [
        a > index ? a - 1 : a,
        b > index ? b - 1 : b,
      ] as [number, number]);
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Add an edge */
  addEdge(from: number, to: number): void {
    this._edges.push([from, to]);
    this.rebuildBuffer();
    this.geometryVersion++;
  }

  /** Remove an edge by index */
  removeEdge(index: number): void {
    if (index >= 0 && index < this._edges.length) {
      this._edges.splice(index, 1);
      this.rebuildBuffer();
      this.geometryVersion++;
    }
  }

  /** Set node color */
  setNodeColor(color: Vec3): void {
    this.params.nodeColor = color;
  }

  /** Set edge color */
  setEdgeColor(color: Vec3): void {
    this.params.edgeColor = color;
  }

  /** Set node display size */
  setNodeSize(size: number): void {
    this.params.nodeSize = size;
  }

  /**
   * Build combined GPU buffer:
   * [node positions (N × vec4f)] [edge line vertices (E×2 × vec4f)]
   */
  private rebuildBuffer(): void {
    const nodeCount = this._nodes.length;
    const edgeVertexCount = this._edges.length * 2;

    this.params.nodeCount       = nodeCount;
    this.params.edgeVertexCount = edgeVertexCount;

    const totalVec4s = nodeCount + edgeVertexCount;
    if (totalVec4s === 0) {
      this._gpuBuffer = MIN_VEC4_BUFFER;
      return;
    }

    const buf = new Float32Array(totalVec4s * 4);
    let offset = 0;

    // Pack node positions
    for (let i = 0; i < nodeCount; i++) {
      buf[offset++] = this._nodes[i][0];
      buf[offset++] = this._nodes[i][1];
      buf[offset++] = this._nodes[i][2];
      buf[offset++] = 1.0; // w
    }

    // Pack edge line vertices (2 verts per edge, referencing node positions)
    for (const [from, to] of this._edges) {
      if (from < nodeCount && to < nodeCount) {
        buf[offset++] = this._nodes[from][0];
        buf[offset++] = this._nodes[from][1];
        buf[offset++] = this._nodes[from][2];
        buf[offset++] = 0.0;
        buf[offset++] = this._nodes[to][0];
        buf[offset++] = this._nodes[to][1];
        buf[offset++] = this._nodes[to][2];
        buf[offset++] = 0.0;
      }
    }

    this._gpuBuffer = buf;
  }

  // === BaseLayer interface ===
  // Note: NetworkLayer provides geometry for the NODE pass by default.
  // The view renderer handles the two-pass approach by checking for
  // the edge data. For MVP, we render nodes as instanced quads.

  getGeometry(): Geometry {
    return {
      vertices      : EMPTY_VERTEX_BUFFER,
      vertexCount   : 6,
      vertexStride  : 4,
      vertexFormat  : "float32",
      topology      : "triangle-list",
      instanceCount : this._nodes.length,
    };
  }

  override getShader(): Shader {
    return {
      code      : shaderCode,
      vertex    : "vs_node",
      fragment  : "fs_node",
    };
  }

  getParams(): LayerParams {
    return this.params;
  }

  override getStorageData(): { data: Float32Array; label?: string } | null {
    return { data: this._gpuBuffer, label: `Network ${this.id} Data` };
  }
}
