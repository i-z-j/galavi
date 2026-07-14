// ============================================================================
// Volume Shader
// ============================================================================
// Renders 3D volumetric data using raycast through viewport cube [0,1]³.
// Visible storage chunks are indexed through a dynamic per-frame grid.
//
// Strategy:
// - Ray marching scoped to [0,1]³, MIP accumulation
//
// Bind Group Layout:
//   @group(0) - Common (Camera + Params + Texture + Sampler)
//   @group(1) - Tile System (indices, ready flags, regions)
// ============================================================================

// === Camera Uniforms ===
struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

// === Parameters ===
struct Params {
  contrast           : vec2f,  // x=scale, y=offset for windowing
  step_size          : f32,    // Precomputed ray step size in viewport space
  opacity            : f32,
  viewport_origin    : vec3f,  // Where viewport [0,1]³ starts in volume
  _pad1              : f32,
  viewport_size      : vec3f,  // Size of viewport in volume coordinates
  _pad2              : f32,
  viewport_inv_size  : vec3f,  // 1 / viewport_size (precomputed)
  _pad3              : f32,
  ray_origin_view    : vec3f,  // Camera eye in viewport space
  _pad4              : f32,
  grid_origin        : vec3f,  // First visible chunk origin in normalized data space
  _pad5              : f32,
  tile_norm_size     : vec3f,  // Nominal storage-chunk size in normalized data space
  _pad6              : f32,
  grid_shape         : vec3f,  // Visible chunk count per axis
  _pad7              : f32,
};

// === Tile Region ===
// Maps viewport position to tile-local UV:
//   local_uv = (viewport_pos - start) * scale
struct TileRegion {
  start     : vec3f,  // Absolute normalized data origin of this tile
  _pad0     : f32,
  scale     : vec3f,  // Inverse normalized tile size
  _pad1     : f32,
  bias      : vec3f,  // Precomputed = -start * scale
  _pad2     : f32,
  tex_offset: vec3f,  // Texture pool offset (normalized)
  _pad3     : f32,
  tex_scale : vec3f,  // Texture pool scale (tile/pool size)
  _pad4     : f32,
};

// === Bindings ===
@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var texr            : texture_3d<f32>;
@group(0) @binding(3) var smpl            : sampler;
@group(0) @binding(4) var colormap_tex    : texture_2d<f32>;
@group(0) @binding(5) var colormap_smpl   : sampler;
@group(0) @binding(6) var<uniform> model  : mat4x4f;

// Tile system
@group(1) @binding(0) var<storage, read> idx_li   : array<vec2u>;  // [curr, prev] per grid cell
@group(1) @binding(1) var<storage, read> ready_li : array<u32>;    // 1 = loaded
@group(1) @binding(2) var<storage, read> regions  : array<TileRegion>;

// === Constants ===
const MAX_STEPS : i32 = 256;
const MIP_EARLY_EXIT : f32 = 0.95;

// === Vertex I/O ===
struct VertexIn {
  @location(0) position : vec3f,
};

struct VertexOut {
  @builtin(position) clip_pos  : vec4f,
  @location(0)       world_pos : vec3f,
  @location(1)       view_pos  : vec3f, // viewport-space position in [0,1]^3
};

// ============================================================================
// Vertex Shader - Transform unit cube to viewport region in volume
// ============================================================================

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  // Transform unit cube [0,1]³ to viewport region in volume coordinates
  let volume_pos = params.viewport_origin + input.position * params.viewport_size;
  out.world_pos = volume_pos;
  out.view_pos = (volume_pos - params.viewport_origin) * params.viewport_inv_size;
  // Apply model matrix for clip space position
  out.clip_pos = scene.world_to_clip * model * vec4f(volume_pos, 1.0);
  return out;
}

// ============================================================================
// Helper: Sample volume at position (in volume coordinates)
// ============================================================================

// Returns sampled value, or -1.0 if tile not loaded (sentinel for discard)
fn sample_at(viewport_pos: vec3f) -> f32 {
  // Check if inside viewport
  if (any(viewport_pos < vec3f(0.0)) || any(viewport_pos > vec3f(1.0))) {
    return -1.0;  // Outside viewport, no data
  }

  let data_pos = params.viewport_origin + viewport_pos * params.viewport_size;
  let cell = vec3i(floor((data_pos - params.grid_origin) / params.tile_norm_size));
  let grid_shape = vec3i(params.grid_shape);
  if (any(cell < vec3i(0)) || any(cell >= grid_shape)) {
    return -1.0;
  }
  let grid_idx = u32(cell.z * grid_shape.x * grid_shape.y + cell.y * grid_shape.x + cell.x);

  // Get tile slot (current, with a spatially covering coarse fallback)
  let indices = idx_li[grid_idx];
  var slot = indices.y;
  if (indices.x != 0u && ready_li[indices.x] == 1u) {
    slot = indices.x;
  }

  // Skip if no tile ready (slot 0 is placeholder)
  if (ready_li[slot] == 0u || slot == 0u) {
    return -1.0;  // Tile not loaded, signal to discard
  }

  let region = regions[slot];

  // Convert viewport position to tile-local UV [0,1]³
  let local_uv = data_pos * region.scale + region.bias;

  // Discard samples outside tile's valid UV range (prevents edge clamping artifacts)
  if (any(local_uv < vec3f(0.0)) || any(local_uv > vec3f(1.0))) {
    return -1.0;  // Outside tile bounds
  }

  // Convert to texture pool coordinates
  let tex_coord = region.tex_offset + local_uv * region.tex_scale;

  return textureSampleLevel(texr, smpl, tex_coord, 0.0).r;
}

// Jitter hash for ray start randomization
fn hash12(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// ============================================================================
// Fragment Shader - Raycast MIP through viewport region
// ============================================================================

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  // Ray-box intersection in viewport space [0,1]^3
  let ray_origin_view = params.ray_origin_view;
  let ray_dir_view = normalize(input.view_pos - ray_origin_view);
  let box_min = vec3f(0.0);
  let box_max = vec3f(1.0);

  let inv_dir = 1.0 / (ray_dir_view + vec3f(1e-10));
  let t0 = (box_min - ray_origin_view) * inv_dir;
  let t1 = (box_max - ray_origin_view) * inv_dir;

  let t_min = min(t0, t1);
  let t_max = max(t0, t1);

  let t_near = max(max(t_min.x, t_min.y), t_min.z);
  let t_far = min(min(t_max.x, t_max.y), t_max.z);

  if (t_near > t_far || t_far < 0.0) {
    discard;
  }

  // Step size is precomputed per-frame for the current viewport
  let step = params.step_size;

  // MIP ray marching
  let jitter = (hash12(input.view_pos.xy) - 0.5) * step;
  var t = max(t_near, 0.0) + step * 0.5 + jitter;
  var max_val = 0.0;
  var has_valid_sample = false;

  for (var i = 0; i < MAX_STEPS; i++) {
    if (t > t_far) { break; }

    let pos_view = ray_origin_view + ray_dir_view * t;
    let val = sample_at(pos_view);

    // Only accumulate valid samples (val >= 0 means tile is loaded)
    if (val >= 0.0) {
      has_valid_sample = true;
      max_val = max(max_val, val);
    }

    // Early exit for MIP
    if (max_val >= MIP_EARLY_EXIT) { break; }

    t += step;
  }

  // Discard fragments with no valid samples (all tiles unloaded along ray)
  if (!has_valid_sample) {
    discard;
  }

  // Apply contrast
  let norm = clamp(max_val * params.contrast.x + params.contrast.y, 0.0, 1.0);
  let color = textureSample(colormap_tex, colormap_smpl, vec2f(norm, 0.5));
  return vec4f(color.rgb, color.a * params.opacity);
}

