/**
 * Shape contract — the shared shape/intersection vocabulary.
 *
 * `ShapeEntry` is produced both by user-supplied shape configs and by the
 * surface-plane intersection (`intersect.ts`); owning it here breaks the
 * `shape/main ↔ shape/intersect` type cycle (intersect no longer imports the
 * layer class module).
 */

import type { Vec3 } from "../../../state/schema";

/** A single shape entry */
export interface ShapeEntry {
  /** Vertex positions as [x, y] pairs in normalized [0,1]² space */
  vertices      : [number, number][];
  /** Optional left tangent vectors per vertex (for Bezier/Hermite curves) */
  tangentLeft?  : [number, number][];
  /** Optional right tangent vectors per vertex (for Bezier/Hermite curves) */
  tangentRight? : [number, number][];
  /** Optional label for this shape */
  label?        : string;
  /** Optional per-entry color override */
  color?        : Vec3;
}
