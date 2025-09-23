// ============================================================================
// Reference Planes Shader - Glass-feel orientation planes
// ============================================================================
// Renders 3 semi-transparent planes (XY, XZ, YZ) showing slice positions.
// Each plane is centered on the surface but positioned along its normal axis
// based on the slice target.
//
// Bind Group Layout:
//   @group(0) @binding(0) - Camera uniforms
//   @group(0) @binding(1) - Plane params (surfaceCenter, size, sliceTarget, opacity)
// ============================================================================

// === Camera Uniforms ===
struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

// === Plane Parameters ===
struct PlaneParams {
  surface_center  : vec3f,    // Surface center - planes centered here for in-plane axes
  size            : f32,       // Half-size of each plane
  slice_target    : vec3f,     // Slice target - each plane positioned along normal to here
  opacity         : f32,       // Base opacity (0.15-0.3 for glass effect)
};

@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : PlaneParams;

// === Vertex I/O ===
struct VertexIn {
  @location(0) position : vec3f,  // Local quad position [-1,1]
  @location(1) plane_id : f32,    // 0=XY (blue), 1=XZ (green), 2=YZ (red)
};

struct VertexOut {
  @builtin(position) clip_pos   : vec4f,
  @location(0)       world_pos  : vec3f,
  @location(1)       plane_id   : f32,
  @location(2)       local_uv   : vec2f,  // For edge highlighting
};

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  
  let local = input.position;
  let pid   = u32(input.plane_id);
  var world_pos: vec3f;
  
  // Transform local [-1,1] quad to world position based on plane orientation
  // Each plane is centered on surface_center for in-plane axes,
  // but positioned at slice_target for the normal axis
  let s = params.size;
  let m = params.surface_center; // surface center (for in-plane positioning)
  let t = params.slice_target;  // slice target (for normal axis positioning)
  
  if (pid == 0u) {
    // XY plane (Z-normal) - blue
    // Centered at surface X,Y but at slice target Z
    world_pos = vec3f(m.x + local.x * s, m.y + local.y * s, t.z);
  } else if (pid == 1u) {
    // XZ plane (Y-normal) - green
    // Centered at surface X,Z but at slice target Y
    world_pos = vec3f(m.x + local.x * s, t.y, m.z + local.y * s);
  } else {
    // YZ plane (X-normal) - red
    // Centered at surface Y,Z but at slice target X
    world_pos = vec3f(t.x, m.y + local.x * s, m.z + local.y * s);
  }
  
  out.world_pos = world_pos;
  out.clip_pos  = scene.world_to_clip * vec4f(world_pos, 1.0);
  out.plane_id  = input.plane_id;
  out.local_uv  = local.xy * 0.5 + 0.5;  // Map [-1,1] to [0,1]
  
  return out;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let pid = u32(input.plane_id);
  // Axis colors (standard convention)
  // pid mapping: 0 = XY (Z axis) -> Blue, 1 = XZ (Y axis) -> Green, 2 = YZ (X axis) -> Red
  var axis_color: vec3f;
  if (pid == 0u) {
    // Z axis (blue): rgba(80,140,240)
    axis_color = vec3f(80.0/255.0, 140.0/255.0, 240.0/255.0);
  } else if (pid == 1u) {
    // Y axis (green): rgba(60,200,120)
    axis_color = vec3f(60.0/255.0, 200.0/255.0, 120.0/255.0);
  } else {
    // X axis (red): rgba(220,60,60)
    axis_color = vec3f(220.0/255.0, 60.0/255.0, 60.0/255.0);
  }

  // UV and edge factor for subtle rim/enhancement
  let uv          = input.local_uv;
  let edge_dist   = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let edge_width  = 0.08;
  let edge_factor = 1.0 - smoothstep(0.0, edge_width, edge_dist);

  // Base alpha (from uniform) with slight center fade
  let center_dist = length(uv - vec2f(0.5));
  let center_fade = 0.9 + 0.35 * center_dist; // center slightly darker
  var alpha = params.opacity * center_fade + edge_factor * 0.12;

  // Intersection lines (thin, higher-contrast) at plane center
  let lineWidth = 0.012; // small thin center lines
  let lx = abs(uv.x - 0.5);
  let ly = abs(uv.y - 0.5);
  let fx = 1.0 - smoothstep(0.0, lineWidth, lx);
  let fy = 1.0 - smoothstep(0.0, lineWidth, ly);
  let lineFactor = max(fx, fy);

  // Compose color: base + edge brighten, amplify on intersection line
  var color = axis_color * (0.85 + edge_factor * 0.25);
  if (lineFactor > 0.0) {
    color = mix(color, axis_color * 1.25, lineFactor);
    alpha = max(alpha, lineFactor * 0.9);
  }

  return vec4f(color, alpha);
}
