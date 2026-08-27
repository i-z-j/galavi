// ============================================================================
// Segmentation Shader — Categorical label rendering
// ============================================================================
// Renders integer label data with a categorical colormap.
// Label 0 = transparent background. Each non-zero label maps to a
// deterministic color via a hash function.
//
// Bind Group Layout:
//   @group(0) @binding(0) - Camera uniforms
//   @group(0) @binding(1) - Segmentation params
//   @group(0) @binding(2) - Model matrix
//   @group(0) @binding(3) - Label data (storage buffer, u32 array)
// ============================================================================

struct Scene {
  world_to_clip : mat4x4f,
  clip_to_world : mat4x4f,
  eye           : vec4f,
};

struct Params {
  opacity        : f32,
  selected_label : i32,    // -1 = no selection
  shape          : f32,    // outline thickness (0 = filled)
  show_selected  : f32,    // 1.0 = show only selected label
  data_width     : u32,
  data_height    : u32,
  num_labels     : u32,
  _pad           : u32,
};

@group(0) @binding(0) var<uniform> scene  : Scene;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<uniform> model  : mat4x4f;
@group(0) @binding(3) var<storage, read> labels : array<u32>;

struct VertexOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       uv       : vec2f,
};

// Full-screen quad
const QUAD_POS = array<vec2f, 6>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(1.0, 1.0),
  vec2f(0.0, 0.0),
  vec2f(1.0, 1.0),
  vec2f(0.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VertexOut {
  var out: VertexOut;
  let pos = QUAD_POS[vid];
  out.clip_pos = scene.world_to_clip * model * vec4f(pos.x, pos.y, 0.0, 1.0);
  out.uv = pos;
  return out;
}

// Deterministic hash: label ID → color
fn label_color(label_id: u32) -> vec3f {
  // Simple hash-based categorical colormap
  var h = label_id;
  h = ((h >> 16u) ^ h) * 0x45d9f3bu;
  h = ((h >> 16u) ^ h) * 0x45d9f3bu;
  h = (h >> 16u) ^ h;
  let r = f32((h >>  0u) & 0xFFu) / 255.0;
  let g = f32((h >>  8u) & 0xFFu) / 255.0;
  let b = f32((h >> 16u) & 0xFFu) / 255.0;
  // Boost saturation: clamp minimum brightness
  let mx = max(r, max(g, b));
  let boost = select(1.0, 0.5 / mx, mx < 0.3);
  return clamp(vec3f(r, g, b) * boost, vec3f(0.0), vec3f(1.0));
}

// Check if pixel is on a shape boundary
fn is_shape_boundary(ix: u32, iy: u32, label_id: u32) -> bool {
  let w = params.data_width;
  let h = params.data_height;
  // Check 4-connected neighbors
  if (ix > 0u && labels[iy * w + ix - 1u] != label_id) { return true; }
  if (ix < w - 1u && labels[iy * w + ix + 1u] != label_id) { return true; }
  if (iy > 0u && labels[(iy - 1u) * w + ix] != label_id) { return true; }
  if (iy < h - 1u && labels[(iy + 1u) * w + ix] != label_id) { return true; }
  return false;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let w = params.data_width;
  let h = params.data_height;
  if (w == 0u || h == 0u) { discard; }

  let ix = u32(clamp(input.uv.x * f32(w), 0.0, f32(w) - 1.0));
  let iy = u32(clamp(input.uv.y * f32(h), 0.0, f32(h) - 1.0));
  let idx = iy * w + ix;

  if (idx >= arrayLength(&labels)) { discard; }
  let label_id = labels[idx];

  // Label 0 = background → transparent
  if (label_id == 0u) { discard; }

  // Show-selected-only mode
  if (params.show_selected > 0.5 && params.selected_label >= 0 && label_id != u32(params.selected_label)) {
    discard;
  }

  let color = label_color(label_id);

  // Shape mode: only show boundary pixels
  if (params.shape > 0.5) {
    if (!is_shape_boundary(ix, iy, label_id)) { discard; }
  }

  // Highlight selected label
  var alpha = params.opacity;
  if (params.selected_label >= 0 && label_id == u32(params.selected_label)) {
    alpha = min(alpha * 1.5, 1.0);
  }

  return vec4f(color, alpha);
}
