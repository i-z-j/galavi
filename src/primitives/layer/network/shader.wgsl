// ============================================================================
// Network Shader — Nodes (instanced circles) + Edges (lines)
// ============================================================================
// Two-pass rendering: edges as line-list, then nodes as instanced billboard quads.
// Unified into a single shader with a mode flag to select pass.
//
// Bind Group Layout:
//   @group(0) @binding(0) - Camera uniforms
//   @group(0) @binding(1) - Network params
//   @group(0) @binding(2) - Model matrix
//   @group(0) @binding(3) - Data buffer (node positions + edge vertex positions)
// ============================================================================

struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

struct Params {
  node_color  : vec3f,
  node_size   : f32,
  edge_color  : vec3f,
  opacity     : f32,
  node_count  : u32,
  edge_vcount : u32,   // number of edge line vertices (2 per edge)
  mode        : u32,   // 0 = edges (line-list), 1 = nodes (instanced)
  _pad        : u32,
};

@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;
// Layout: [node_positions (node_count × vec4f)] [edge_vertices (edge_vcount × vec4f)]
@group(0) @binding(3) var<storage, read> data : array<vec4f>;

struct VertexOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       uv       : vec2f,
  @location(1)       color    : vec4f,
};

const QUAD_UV = array<vec2f, 6>(
  vec2f(-1.0, -1.0),
  vec2f( 1.0, -1.0),
  vec2f( 1.0,  1.0),
  vec2f(-1.0, -1.0),
  vec2f( 1.0,  1.0),
  vec2f(-1.0,  1.0),
);

// ============================================================================
// Node vertex shader (instanced billboards, like PointsLayer)
// ============================================================================
@vertex
fn vs_node(
  @builtin(vertex_index)   vid : u32,
  @builtin(instance_index) iid : u32,
) -> VertexOut {
  var out: VertexOut;

  let pt = data[iid];
  let world_center = (model * vec4f(pt.xyz, 1.0)).xyz;

  let cam_dir = normalize(scene.eye.xyz - world_center);
  var world_up = vec3f(0.0, 1.0, 0.0);
  if (abs(dot(cam_dir, world_up)) > 0.99) {
    world_up = vec3f(0.0, 0.0, 1.0);
  }
  let right = normalize(cross(world_up, cam_dir));
  let up    = normalize(cross(cam_dir, right));

  let corner = QUAD_UV[vid];
  let offset = (right * corner.x + up * corner.y) * params.node_size;
  let world_pos = world_center + offset;

  out.clip_pos = scene.world_to_clip * vec4f(world_pos, 1.0);
  out.uv = corner;
  out.color = vec4f(params.node_color, params.opacity);
  return out;
}

// ============================================================================
// Edge vertex shader (line-list)
// ============================================================================
@vertex
fn vs_edge(
  @builtin(vertex_index) vid : u32,
) -> VertexOut {
  var out: VertexOut;

  // Edge vertices are stored after node positions
  let edge_offset = params.node_count;
  let pos = data[edge_offset + vid].xyz;
  let world_pos = (model * vec4f(pos, 1.0)).xyz;

  out.clip_pos = scene.world_to_clip * vec4f(world_pos, 1.0);
  out.uv = vec2f(0.0);
  out.color = vec4f(params.edge_color, params.opacity);
  return out;
}

// ============================================================================
// Shared fragment shader
// ============================================================================
@fragment
fn fs_node(input: VertexOut) -> @location(0) vec4f {
  // Circle discard for nodes
  let dist = length(input.uv);
  if (dist > 1.0) { discard; }
  let edge_aa = smoothstep(0.85, 1.0, dist);
  return vec4f(input.color.rgb, input.color.a * (1.0 - edge_aa));
}

@fragment
fn fs_edge(input: VertexOut) -> @location(0) vec4f {
  return input.color;
}
