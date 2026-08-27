/**
 * Empty placeholder vertex buffer for instanced layers whose actual vertex
 * data comes from a storage buffer or shader-side const array. WebGPU still
 * requires a non-empty bound vertex buffer; this 6-float stub is large enough
 * for any topology used in the codebase (line-list × 1 instance up to
 * triangle-list × 1 instance).
 */
export const EMPTY_VERTEX_BUFFER = new Float32Array(6);

/**
 * Compute axis-aligned bounding box from a packed positions buffer.
 * Stride defaults to 3 (xyz). Empty input returns the unit cube.
 */
export function aabbFromPositions(
  positions: Float32Array,
  stride: number = 3,
): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += stride) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  if (!isFinite(min[0])) {
    return { min: [0, 0, 0], max: [1, 1, 1] };
  }
  return { min, max };
}

export const UNIT_CUBE = new Float32Array([
  0, 0, 1,  1, 0, 1,  1, 1, 1,
  0, 0, 1,  1, 1, 1,  0, 1, 1,
  1, 0, 0,  0, 0, 0,  0, 1, 0,
  1, 0, 0,  0, 1, 0,  1, 1, 0,
  0, 1, 1,  1, 1, 1,  1, 1, 0,
  0, 1, 1,  1, 1, 0,  0, 1, 0,
  0, 0, 0,  1, 0, 0,  1, 0, 1,
  0, 0, 0,  1, 0, 1,  0, 0, 1,
  1, 0, 1,  1, 0, 0,  1, 1, 0,
  1, 0, 1,  1, 1, 0,  1, 1, 1,
  0, 0, 0,  0, 0, 1,  0, 1, 1,
  0, 0, 0,  0, 1, 1,  0, 1, 0,
]);