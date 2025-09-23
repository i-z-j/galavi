// ============================================================================
// Points Shader — Billboard circles
// ============================================================================
// Renders points as camera-facing billboard quads with circular discard.
// Uses instanced rendering: one quad (6 vertices) per point.
//
// Bind Group Layout:
//   @group(0) @binding(0) - Camera uniforms
//   @group(0) @binding(1) - Points params (color, size, count)
//   @group(0) @binding(2) - Model matrix
//   @group(0) @binding(3) - Point positions (storage buffer)
// ============================================================================

// === Camera Uniforms ===
struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

// === Points Parameters ===
struct Params {
  color     : vec3f,
  opacity   : f32,
  size      : f32,     // Point radius in world-space units
  edge_width: f32,     // Anti-aliased edge width (0-1)
  _pad      : vec2f,
};

// === Bindings ===
@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;
@group(0) @binding(3) var<storage, read> positions : array<vec4f>;

// === Vertex I/O ===
struct VertexOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       uv       : vec2f,   // [-1,1] quad UV for circle test
  @location(1)       pt_color : vec4f,   // per-point color (future)
};

// Quad corner offsets: 2 triangles forming a [-1,1] quad
const QUAD_UV = array<vec2f, 6>(
  vec2f(-1.0, -1.0),
  vec2f( 1.0, -1.0),
  vec2f( 1.0,  1.0),
  vec2f(-1.0, -1.0),
  vec2f( 1.0,  1.0),
  vec2f(-1.0,  1.0),
);

// ============================================================================
// Vertex Shader
// ============================================================================
@vertex
fn vs_main(
  @builtin(vertex_index)   vid : u32,
  @builtin(instance_index) iid : u32,
) -> VertexOut {
  var out: VertexOut;

  // Read point position from storage buffer
  let pt = positions[iid];
  let world_center = (model * vec4f(pt.xyz, 1.0)).xyz;

  // Billboard: offset quad corners in camera-right and camera-up directions
  let cam_dir = normalize(scene.eye.xyz - world_center);
  // Derive right/up from camera direction (avoid degenerate up)
  var world_up = vec3f(0.0, 1.0, 0.0);
  if (abs(dot(cam_dir, world_up)) > 0.99) {
    world_up = vec3f(0.0, 0.0, 1.0);
  }
  let right = normalize(cross(world_up, cam_dir));
  let up    = normalize(cross(cam_dir, right));

  let corner = QUAD_UV[vid];
  let offset = (right * corner.x + up * corner.y) * params.size;
  let world_pos = world_center + offset;

  out.clip_pos = scene.world_to_clip * vec4f(world_pos, 1.0);
  out.uv = corner;
  out.pt_color = vec4f(params.color, params.opacity);

  return out;
}

// ============================================================================
// Fragment Shader
// ============================================================================
@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  // Distance from quad center → discard outside circle
  let dist = length(input.uv);
  if (dist > 1.0) {
    discard;
  }

  // Smooth anti-aliased edge
  let edge = params.edge_width;
  let alpha = input.pt_color.a * smoothstep(1.0, 1.0 - edge, dist);

  return vec4f(input.pt_color.rgb, alpha);
}
