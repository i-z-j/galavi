// ============================================================================
// Slice Shader (Unified 3D Tile Layout)
// ============================================================================
// Renders 2D slices from volumetric data with tile-based streaming.
// Uses the same 3D TileRegion struct as the volume shader for
// unified tile pool access.
//
// Tile lookup:
//   local_uv = viewport_pos * region.scale + region.bias
//   tex_coord = region.tex_offset + local_uv * region.tex_scale
// ============================================================================

// === Camera Uniforms ===
struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

// === Parameters ===
struct Params {
  contrast        : vec2f,  // x=scale, y=offset for windowing
  opacity         : f32,
  _pad0           : f32,
  viewport_origin : vec2f,  // Where viewport [0,1]² starts in world space
  viewport_size   : vec2f,  // Size of viewport region in world space
};

// === Tile Region (unified 3D) ===
struct TileRegion {
  start     : vec3f,
  _pad0     : f32,
  scale     : vec3f,
  _pad1     : f32,
  bias      : vec3f,
  _pad2     : f32,
  tex_offset: vec3f,
  _pad3     : f32,
  tex_scale : vec3f,
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
@group(1) @binding(0) var<storage, read> idx_li   : array<vec2u>;       // [curr, prev] per grid cell
@group(1) @binding(1) var<storage, read> ready_li : array<u32>;         // 1 = loaded
@group(1) @binding(2) var<storage, read> regions  : array<TileRegion>;  // per slot

// === Vertex I/O ===
struct VertexInput {
  @location(0) model_pos : vec2f,              // Unit square [0,1]²
  @builtin(instance_index) instance_id : u32,  // Grid cell index (0..8)
};

struct VertexOutput {
  @builtin(position) clip_pos     : vec4f,
  @location(0)       viewport_pos : vec2f,  // Position in viewport [0,1]²
};

// ============================================================================
// Vertex Shader
// ============================================================================
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Transform unit square [0,1]² to viewport region in world space
  let world_xy = params.viewport_origin + input.model_pos * params.viewport_size;
  // Apply model matrix for clip space position
  output.clip_pos = scene.world_to_clip * model * vec4f(world_xy, 0.0, 1.0);
  // viewport_pos is always in [0,1]² — aligned with tile grid cells
  output.viewport_pos = input.model_pos;

  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let vp = input.viewport_pos;

  // Discard outside [0,1]²
  if (vp.x < 0.0 || vp.x > 1.0 || vp.y < 0.0 || vp.y > 1.0) {
    discard;
  }

  // Determine which 3×3 grid cell this fragment belongs to
  let cell = clamp(vec2i(floor(vp * 3.0)), vec2i(0), vec2i(2));
  let grid_idx = u32(cell.y * 3 + cell.x);

  // Select tile slot (current if ready, else fallback to previous)
  let indices = idx_li[grid_idx];
  let slot = select(indices.y, indices.x, ready_li[indices.x] == 1u);

  if (ready_li[slot] == 0u) {
    discard;
  }

  let region = regions[slot];

  // Compute tile-local UV from grid cell position (not from region start/scale/bias).
  // This avoids drift when tiles are reused across bucket changes:
  // each grid cell maps its [cell/3, (cell+1)/3] viewport range to [0,1].
  let cell_origin = vec2f(f32(cell.x), f32(cell.y)) / 3.0;
  let local_xy = (vp - cell_origin) * 3.0;

  if (local_xy.x < 0.0 || local_xy.x > 1.0 || local_xy.y < 0.0 || local_xy.y > 1.0) {
    discard;
  }

  let local_uv = vec3f(local_xy, 0.5);

  // Convert to pool texture coordinates
  let tex_coord = region.tex_offset + local_uv * region.tex_scale;

  let color = textureSample(texr, smpl, tex_coord).r;

  // Apply contrast windowing
  let norm = clamp(color * params.contrast.x + params.contrast.y, 0.0, 1.0);
  let mapped = textureSample(colormap_tex, colormap_smpl, vec2f(norm, 0.5));
  return vec4f(mapped.rgb, mapped.a * params.opacity);
}
