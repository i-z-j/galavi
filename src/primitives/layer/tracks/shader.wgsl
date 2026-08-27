// ============================================================================
// Tracks Shader — Time-aware line strips with tail fading
// ============================================================================
// Renders track segments as line-list with per-vertex alpha fading
// based on temporal distance from current time.
//
// Bind Group Layout:
//   @group(0) @binding(0) - Camera uniforms
//   @group(0) @binding(1) - Tracks params
//   @group(0) @binding(2) - Model matrix
//   @group(0) @binding(3) - Track vertex data (storage buffer)
// ============================================================================

struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

struct Params {
  color       : vec3f,
  opacity     : f32,
  current_time: f32,
  tail_length : f32,    // number of time units for tail visibility
  tail_width  : f32,
  _pad        : f32,
};

@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;
// Each vertex: vec4f(x, y, z, time)
@group(0) @binding(3) var<storage, read> track_data : array<vec4f>;

struct VertexOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       alpha    : f32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vid : u32,
) -> VertexOut {
  var out: VertexOut;

  let v = track_data[vid];
  let pos = v.xyz;
  let t = v.w;

  let world_pos = (model * vec4f(pos, 1.0)).xyz;
  out.clip_pos = scene.world_to_clip * vec4f(world_pos, 1.0);

  // Temporal alpha: fade out points older than tail_length
  let dt = params.current_time - t;
  if (dt < 0.0 || dt > params.tail_length) {
    // Outside visible window — degenerate to zero-area
    out.clip_pos = vec4f(0.0, 0.0, -2.0, 1.0);
    out.alpha = 0.0;
  } else {
    out.alpha = 1.0 - dt / params.tail_length;
  }

  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  if (input.alpha <= 0.0) { discard; }
  return vec4f(params.color, params.opacity * input.alpha);
}
