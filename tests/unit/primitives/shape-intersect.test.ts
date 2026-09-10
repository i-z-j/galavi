import { describe, expect, test } from "vitest";
import {
  intersectSurfaceWithPlane,
  type ShapeEntry,
} from "../../../src/primitives/layer/shape/main";
import type { AxisMap } from "../../../src/utils";

/** Match two [u, v] point sets order-independently within a tolerance. */
function expectPointSet(
  actual    : [number, number][],
  expected  : [number, number][],
  tolerance = 5e-4,
): void {
  expect(actual).toHaveLength(expected.length);
  const used = new Array<boolean>(actual.length).fill(false);
  for (const [eu, ev] of expected) {
    const idx = actual.findIndex((p, i) =>
      !used[i] &&
      Math.abs(p[0] - eu) <= tolerance &&
      Math.abs(p[1] - ev) <= tolerance);
    expect(idx, `expected a point near (${eu}, ${ev})`).toBeGreaterThanOrEqual(0);
    if (idx >= 0) used[idx] = true;
  }
}

/** Pack triangle vertex triples into a flat Float32Array. */
function packTriangles(...tris: [number, number, number][][]): Float32Array {
  return new Float32Array(tris.flat(2));
}

// Tetrahedron with apex above the z=0.5 plane and base below it. The plane
// cuts the three side faces at the midpoints of the apex-to-base edges,
// producing a closed triangle contour.
const TETRA_Z = packTriangles(
  // base (fully below the plane)
  [[0.2, 0.2, 0.1], [0.8, 0.2, 0.1], [0.5, 0.8, 0.1]],
  // side faces
  [[0.5, 0.5, 0.9], [0.2, 0.2, 0.1], [0.8, 0.2, 0.1]],
  [[0.5, 0.5, 0.9], [0.8, 0.2, 0.1], [0.5, 0.8, 0.1]],
  [[0.5, 0.5, 0.9], [0.5, 0.8, 0.1], [0.2, 0.2, 0.1]],
);

// Same tetrahedron with y as the vertical axis, for the y=0.5 plane.
const TETRA_Y = packTriangles(
  [[0.2, 0.1, 0.2], [0.8, 0.1, 0.2], [0.5, 0.1, 0.8]],
  [[0.5, 0.9, 0.5], [0.2, 0.1, 0.2], [0.8, 0.1, 0.2]],
  [[0.5, 0.9, 0.5], [0.8, 0.1, 0.2], [0.5, 0.1, 0.8]],
  [[0.5, 0.9, 0.5], [0.5, 0.1, 0.8], [0.2, 0.1, 0.2]],
);

// Expected contour points: midpoints of the tetrahedron's side edges.
const TETRA_CONTOUR: [number, number][] = [
  [0.35, 0.35],
  [0.65, 0.35],
  [0.5, 0.65],
];

describe("intersectSurfaceWithPlane", () => {
  test("returns no entries when the plane misses the surface", () => {
    const triangle = packTriangles(
      [[0.2, 0.2, 0.6], [0.8, 0.2, 0.6], [0.5, 0.8, 0.8]],
    );
    const entries = intersectSurfaceWithPlane(triangle, 2, 0.5, [0, 1, 2] as AxisMap);
    expect(entries).toEqual([]);
  });

  test("chains triangle-face segments into a closed contour", () => {
    const entries = intersectSurfaceWithPlane(TETRA_Z, 2, 0.5, [0, 1, 2] as AxisMap);
    expect(entries).toHaveLength(1);

    const entry: ShapeEntry = entries[0];
    // Closed loop: the last vertex repeats the first.
    expect(entry.vertices).toHaveLength(TETRA_CONTOUR.length + 1);
    const first = entry.vertices[0];
    const last = entry.vertices[entry.vertices.length - 1];
    expect(last[0]).toBeCloseTo(first[0], 6);
    expect(last[1]).toBeCloseTo(first[1], 6);

    // Contour start point and winding are chaining artifacts; compare as a set.
    expectPointSet(entry.vertices.slice(0, -1), TETRA_CONTOUR);
  });

  test("remaps coordinates through a non-z slice axis", () => {
    // Plane perpendicular to Y; 2D coordinates come from (x, z).
    const axisMap: AxisMap = [0, 2, 1];
    const entries = intersectSurfaceWithPlane(TETRA_Y, 1, 0.5, axisMap);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.vertices).toHaveLength(TETRA_CONTOUR.length + 1);
    const first = entry.vertices[0];
    const last = entry.vertices[entry.vertices.length - 1];
    expect(last[0]).toBeCloseTo(first[0], 6);
    expect(last[1]).toBeCloseTo(first[1], 6);

    expectPointSet(entry.vertices.slice(0, -1), TETRA_CONTOUR);
  });

  test("snaps intersection points to vertices within tolerance of the plane", () => {
    // Quad whose upper edge sits just above the plane (within the default
    // 0.001 tolerance): intersection points land on the near-plane vertices
    // rather than at the exact plane crossing.
    const quad = packTriangles(
      [[0.2, 0.2, 0.3], [0.8, 0.2, 0.3], [0.8, 0.8, 0.5005]],
      [[0.2, 0.2, 0.3], [0.8, 0.8, 0.5005], [0.2, 0.8, 0.5005]],
    );
    const entries = intersectSurfaceWithPlane(quad, 2, 0.5, [0, 1, 2] as AxisMap);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    // Two segments chained end-to-end: an open 3-vertex polyline.
    expect(entry.vertices).toHaveLength(3);
    const first = entry.vertices[0];
    const last = entry.vertices[entry.vertices.length - 1];
    expect(Math.abs(last[0] - first[0])).toBeGreaterThan(5e-4);

    expectPointSet(entry.vertices, [
      [0.8, 0.7985],
      [0.7985, 0.7985],
      [0.2, 0.7985],
    ]);
  });

  test("produces no segments for a triangle fully within tolerance but not crossing", () => {
    const triangle = packTriangles(
      [[0.2, 0.2, 0.5005], [0.8, 0.2, 0.5005], [0.5, 0.8, 0.5005]],
    );
    const entries = intersectSurfaceWithPlane(triangle, 2, 0.5, [0, 1, 2] as AxisMap);
    expect(entries).toEqual([]);
  });
});
