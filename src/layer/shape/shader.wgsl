// ============================================================================
// Shapes Shader
// ============================================================================
// Renders 2D shape outlines (closed polygons) as line strips.
// Used for region outlines on slice views.
//
// Bind Group Layout:
//   @group(0) - Common (Camera + Params)
// ============================================================================

// === Camera Uniforms ===
struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

// === Shape Parameters ===
struct Params {
  color   : vec3f,
  opacity : f32,
};

// === Bindings ===
@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;

// === Vertex I/O ===
struct VertexIn {
  @location(0) position : vec2f,
};

struct VertexOut {
  @builtin(position) clip_pos : vec4f,
};

// ============================================================================
// Vertex Shader
// ============================================================================
@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world_pos = (model * vec4f(input.position, 0.0, 1.0)).xyz;
  out.clip_pos = scene.world_to_clip * vec4f(world_pos.xy, 0.0, 1.0);
  return out;
}

// ============================================================================
// Fragment Shader
// ============================================================================
@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(params.color, params.opacity);
}
