// ============================================================================
// Surface Shader
// ============================================================================
// Renders 3D surface geometry with surface or wireframe mode.
// Supports simple directional lighting for surface rendering.
//
// Bind Group Layout:
//   @group(0) - Common (Camera + Params)
// ============================================================================

// === Camera Uniforms ===
struct Scene {
  world_to_clip : mat4x4f,  // Transform: world → clip space
  clip_to_world : mat4x4f,  // Inverse: clip → world (for picking)
  eye           : vec4f,    // Camera position (xyz), w=1
};

// === Surface Parameters ===
struct Params {
  color   : vec3f,   // Base color (RGB)
  opacity : f32,     // Alpha value
  flags   : u32,     // bit 0: wireframe, bit 1: doubleSided
  _pad    : vec3f,
};

// === Bindings ===
@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;

// === Vertex I/O ===
struct VertexIn {
  @location(0) position : vec3f,
};

struct VertexOut {
  @builtin(position) clip_pos  : vec4f,
  @location(0)       world_pos : vec3f,
  @location(1)       view_dir  : vec3f,  // Direction from surface to camera
};

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  
  let world_pos = (model * vec4f(input.position, 1.0)).xyz;
  out.world_pos = world_pos;
  out.clip_pos = scene.world_to_clip * vec4f(world_pos, 1.0);
  out.view_dir = scene.eye.xyz - world_pos;
  
  return out;
}

// ============================================================================
// Fragment Shaders
// ============================================================================

// --- Wireframe Mode ---
// Solid color, no lighting
@fragment
fn fs_wireframe(input: VertexOut) -> @location(0) vec4f {
  return vec4f(params.color, params.opacity);
}

// --- Surface Mode ---
// Simple Blinn-Phong lighting with face normals
@fragment
fn fs_surface(input: VertexOut) -> @location(0) vec4f {
  // Compute face normal from screen-space derivatives
  let dx = dpdx(input.world_pos);
  let dy = dpdy(input.world_pos);
  var normal = normalize(cross(dx, dy));
  
  // View direction (from surface to camera)
  let view_dir = normalize(input.view_dir);
  
  // Check face orientation
  let facing_camera = dot(normal, view_dir) > 0.0;
  let double_sided = (params.flags & 2u) != 0u;
  
  // Flip normal for back faces when double-sided
  if (!facing_camera) {
    if (double_sided) {
      normal = -normal;
    } else {
      discard;
    }
  }
  
  // Simple Three.js-style lighting:
  // 1. Headlight (light from camera direction) - always visible
  // 2. Soft ambient
  let headlight = max(dot(normal, view_dir), 0.0) * 0.6;
  let ambient = 0.4;
  
  let brightness = ambient + headlight;
  let color = params.color * brightness;
  
  return vec4f(color, params.opacity);
}

// --- Flat Shading Mode ---
// Uniform lighting, good for scientific visualization
@fragment
fn fs_flat(input: VertexOut) -> @location(0) vec4f {
  // Compute face normal
  let dx = dpdx(input.world_pos);
  let dy = dpdy(input.world_pos);
  let normal = normalize(cross(dx, dy));
  
  // Simple headlight (from camera)
  let view_dir = normalize(input.view_dir);
  let headlight = abs(dot(normal, view_dir)) * 0.5;  // abs() for both sides
  let ambient = 0.5;
  
  let color = params.color * (ambient + headlight);
  return vec4f(color, params.opacity);
}

// --- X-Ray / Fresnel Translucent Mode ---
// Edge-highlighted see-through rendering for region overlays.
// Faces viewed head-on are nearly transparent; silhouette edges are opaque.
// No diffuse lighting — just Fresnel-based alpha for clean overlay effect.
@fragment
fn fs_xray(input: VertexOut) -> @location(0) vec4f {
  // Compute face normal from screen-space derivatives
  let dx = dpdx(input.world_pos);
  let dy = dpdy(input.world_pos);
  let normal = normalize(cross(dx, dy));

  // View direction (from surface to camera)
  let view_dir = normalize(input.view_dir);

  // Fresnel factor: edges (grazing angle) are opaque, face-on areas transparent
  // abs() makes it double-sided automatically
  let facing = abs(dot(normal, view_dir));
  let fresnel = 1.0 - facing;

  // Shape the falloff: pow > 1 makes center more transparent, edges sharper
  let alpha = params.opacity * pow(fresnel, 1.5);

  // Slight rim tint: brighter at edges for visual definition
  let rim = 0.3 + 0.7 * fresnel;
  let color = params.color * rim;

  return vec4f(color, alpha);
}

