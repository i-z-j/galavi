// ============================================================================
// Vectors Shader — Instanced line segments / arrows
// ============================================================================
// Renders vectors as oriented line segments from start to start+direction*length.
// Uses instanced rendering: one line segment (2 vertices) per vector.
//
// Bind Group Layout:
//   @group(0) @binding(0) - Camera uniforms
//   @group(0) @binding(1) - Vectors params
//   @group(0) @binding(2) - Model matrix
//   @group(0) @binding(3) - Vector data (storage buffer: start.xyz, dir.xyz per entry)
// ============================================================================

struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

struct Params {
  color      : vec3f,
  opacity    : f32,
  length_    : f32,    // direction scale factor
  edge_width : f32,    // line width (visual, not GPU-enforced)
  _pad       : vec2f,
};

@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;
@group(0) @binding(3) var<storage, read> vectors : array<vec4f>;

struct VertexOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       alpha    : f32,
};

@vertex
fn vs_main(
  @builtin(vertex_index)   vid : u32,
  @builtin(instance_index) iid : u32,
) -> VertexOut {
  var out: VertexOut;

  // Each vector uses 2 vec4f slots: [start.xyz, 0] [dir.xyz, 0]
  let start = vectors[iid * 2u].xyz;
  let dir   = vectors[iid * 2u + 1u].xyz;

  // vid=0 → start, vid=1 → start + dir * length
  var pos: vec3f;
  if (vid == 0u) {
    pos = start;
    out.alpha = 0.6; // tail is slightly dimmer
  } else {
    pos = start + dir * params.length_;
    out.alpha = 1.0; // tip is brighter
  }

  let world_pos = (model * vec4f(pos, 1.0)).xyz;
  out.clip_pos = scene.world_to_clip * vec4f(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(params.color * input.alpha, params.opacity);
}
