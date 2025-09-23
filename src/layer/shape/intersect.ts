/**
 * Surface-Plane Intersection
 *
 * Computes the intersection of a triangle surface with an axis-aligned plane,
 * producing 2D shape entries suitable for ShapesLayer rendering.
 *
 * Algorithm:
 * 1. For each triangle, check which edges cross the plane (axis = position).
 * 2. Collect the two intersection points per crossing triangle (a plane
 *    intersects a triangle in exactly 0 or 2 edge crossings, ignoring
 *    degenerate tangent cases).
 * 3. Project intersection points to 2D via the slice's axisMap.
 * 4. Chain connected segments into closed shapes where possible.
 *
 * All coordinates are in normalized [0,1]³ / [0,1]² space.
 */

import type { ShapeEntry } from "./main";
import type { AxisMap } from "../../utils";

// ============================================================================
// TYPES
// ============================================================================

/** A 2D line segment from the surface-plane intersection */
interface Segment {
  a: [number, number];
  b: [number, number];
}

// ============================================================================
// CORE INTERSECTION
// ============================================================================

/**
 * Intersect a triangle surface with an axis-aligned plane.
 *
 * @param positions  - Float32Array of vertex positions (x,y,z triples), normalized [0,1]³
 * @param sliceAxis  - Which axis the plane is perpendicular to (0=X, 1=Y, 2=Z)
 * @param slicePos   - Position along sliceAxis in [0,1]
 * @param axisMap    - [uAxis, vAxis, sliceAxis] mapping 3D → 2D
 * @param tolerance  - Half-thickness of the slab for capturing near-plane triangles (default: 0.001)
 * @returns ShapeEntry[] — closed shapes in [0,1]² slice space
 */
export function intersectSurfaceWithPlane(
  positions : Float32Array,
  sliceAxis : number,
  slicePos  : number,
  axisMap   : AxisMap,
  tolerance = 0.001,
): ShapeEntry[] {
  const uAxis = axisMap[0];
  const vAxis = axisMap[1];
  const segments: Segment[] = [];

  const triCount = Math.floor(positions.length / 9); // 3 verts × 3 floats

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;

    // Triangle vertices along slice axis
    const a0 = positions[base + sliceAxis];
    const a1 = positions[base + 3 + sliceAxis];
    const a2 = positions[base + 6 + sliceAxis];

    // Signed distances from the plane
    const d0 = a0 - slicePos;
    const d1 = a1 - slicePos;
    const d2 = a2 - slicePos;

    // Quick reject: all on same side and beyond tolerance
    if (d0 > tolerance && d1 > tolerance && d2 > tolerance) continue;
    if (d0 < -tolerance && d1 < -tolerance && d2 < -tolerance) continue;

    // Collect intersection points from edges crossing the plane
    const pts: [number, number][] = [];

    collectEdgeIntersection(positions, base, 0, 3, sliceAxis, slicePos, uAxis, vAxis, d0, d1, pts);
    collectEdgeIntersection(positions, base, 3, 6, sliceAxis, slicePos, uAxis, vAxis, d1, d2, pts);
    collectEdgeIntersection(positions, base, 6, 0, sliceAxis, slicePos, uAxis, vAxis, d2, d0, pts);

    if (pts.length >= 2) {
      segments.push({ a: pts[0], b: pts[1] });
    }
  }

  if (segments.length === 0) return [];

  // Chain segments into closed shapes
  return chainSegments(segments);
}

/**
 * Check if an edge crosses the plane; if so, compute the 2D intersection point.
 */
function collectEdgeIntersection(
  positions   : Float32Array,
  base        : number,
  offsetA     : number,
  offsetB     : number,
  _sliceAxis  : number,
  _slicePos   : number,
  uAxis       : number,
  vAxis       : number,
  dA          : number,
  dB          : number,
  pts         : [number, number][],
): void {
  // Edge crosses plane if signs differ (one positive, one negative)
  // Also handle vertex exactly on the plane
  if ((dA > 0 && dB > 0) || (dA < 0 && dB < 0)) return;

  // Both on plane — skip (degenerate, coplanar edge)
  if (dA === 0 && dB === 0) return;

  // Interpolation parameter
  const t = dA / (dA - dB);

  const iA = base + offsetA;
  const iB = base + offsetB;

  const u = positions[iA + uAxis] + t * (positions[iB + uAxis] - positions[iA + uAxis]);
  const v = positions[iA + vAxis] + t * (positions[iB + vAxis] - positions[iA + vAxis]);

  pts.push([u, v]);
}

// ============================================================================
// SEGMENT CHAINING
// ============================================================================

/** Spatial hashing precision for connecting nearby endpoints */
const HASH_PRECISION = 1e5;

function hashPoint(p: [number, number]): string {
  return `${Math.round(p[0] * HASH_PRECISION)},${Math.round(p[1] * HASH_PRECISION)}`;
}

/**
 * Chain line segments into closed shapes.
 *
 * Uses an adjacency-based approach: build a map from endpoint → connected segments,
 * then walk chains greedily. Produces ShapeEntry[] with each entry being a
 * closed (or open) polyline.
 */
function chainSegments(segments: Segment[]): ShapeEntry[] {
  if (segments.length === 0) return [];

  // Build adjacency: endpoint hash → list of segment indices
  const adj = new Map<string, number[]>();
  const used = new Uint8Array(segments.length);

  for (let i = 0; i < segments.length; i++) {
    const hA = hashPoint(segments[i].a);
    const hB = hashPoint(segments[i].b);

    if (!adj.has(hA)) adj.set(hA, []);
    adj.get(hA)!.push(i);

    if (!adj.has(hB)) adj.set(hB, []);
    adj.get(hB)!.push(i);
  }

  const entries: ShapeEntry[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;

    // Start a new chain from this segment
    const chain: [number, number][] = [segments[i].a, segments[i].b];
    used[i] = 1;

    // Extend forward from chain end
    let extended = true;
    while (extended) {
      extended = false;
      const endHash = hashPoint(chain[chain.length - 1]);
      const neighbors = adj.get(endHash);
      if (!neighbors) break;

      for (const ni of neighbors) {
        if (used[ni]) continue;
        used[ni] = 1;
        const seg = segments[ni];

        // Which end connects?
        const hA = hashPoint(seg.a);
        if (hA === endHash) {
          chain.push(seg.b);
        } else {
          chain.push(seg.a);
        }
        extended = true;
        break;
      }
    }

    // Extend backward from chain start
    extended = true;
    while (extended) {
      extended = false;
      const startHash = hashPoint(chain[0]);
      const neighbors = adj.get(startHash);
      if (!neighbors) break;

      for (const ni of neighbors) {
        if (used[ni]) continue;
        used[ni] = 1;
        const seg = segments[ni];

        const hA = hashPoint(seg.a);
        if (hA === startHash) {
          chain.unshift(seg.b);
        } else {
          chain.unshift(seg.a);
        }
        extended = true;
        break;
      }
    }

    // Only emit shape outlines with enough points
    if (chain.length >= 3) {
      entries.push({ vertices: chain });
    }
  }

  return entries;
}

