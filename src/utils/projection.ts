/**
 * Projection utils — physical ↔ screen coordinate mapping.
 *
 * Slice views use an axis-mapped orthographic projection derived from the
 * unified camera (visible half-extent = cameraDistance / 2, matching
 * SliceView framing). Volume views use a perspective projection at
 * DEFAULT_FOV. Pure math — shared by overlays (crosshair, ruler,
 * roi-selector) and apps.
 */

import type { Camera, State, Vec2, Vec3 } from "../types";
import { DEFAULT_FOV } from "../defaults";
import type { AxisMap } from "./axes";
import { cameraDistance } from "./spherical";

const HALF_FOV_TAN = Math.tan(DEFAULT_FOV / 2);

// ============================================================================
// VECTOR HELPERS
// ============================================================================

export function subtract(first: Vec3, second: Vec3): Vec3 {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

export function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function cross(first: Vec3, second: Vec3): Vec3 {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

export function dot(first: Vec3, second: Vec3): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

export function cameraBasis(camera: { position: Vec3; target: Vec3; up?: Vec3 }): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = normalize([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]);
  const right = normalize(cross(forward, (camera.up ?? [0, 1, 0]) as Vec3));
  const up    = normalize(cross(right, forward));
  return { forward, right, up };
}

// ============================================================================
// SLICE VIEWS (axis-mapped orthographic)
// ============================================================================

/** Project a physical position into slice-view screen pixels. */
export function physicalToSliceScreen(
  position  : Vec3,
  state     : State,
  axisMap   : AxisMap,
  width     : number,
  height    : number,
): Vec2 {
  const distance   = cameraDistance(state.exploration.camera);
  const halfExtent = Math.max(distance / 2, 1e-6);
  const aspect     = width / Math.max(height, 1);
  const target     = state.exploration.camera.target;
  const clipX      = (position[axisMap[0]] - target[axisMap[0]]) / (halfExtent * aspect);
  const clipY      = (position[axisMap[1]] - target[axisMap[1]]) / halfExtent;
  return [(clipX * 0.5 + 0.5) * width, (clipY * 0.5 + 0.5) * height];
}

/** Unproject slice-view screen pixels to a physical position on the plane. */
export function screenToSlicePhysical(
  screenX        : number,
  screenY        : number,
  state          : State,
  axisMap        : AxisMap,
  width          : number,
  height         : number,
  normalPosition : number,
): Vec3 {
  const distance   = cameraDistance(state.exploration.camera);
  const halfExtent = Math.max(distance / 2, 1e-6);
  const aspect     = width / Math.max(height, 1);
  const clipX      = (screenX / Math.max(width, 1)) * 2 - 1;
  const clipY      = (screenY / Math.max(height, 1)) * 2 - 1;
  const target     = state.exploration.camera.target;
  const result     = [...target] as Vec3;
  result[axisMap[0]] = target[axisMap[0]] + clipX * halfExtent * aspect;
  result[axisMap[1]] = target[axisMap[1]] + clipY * halfExtent;
  result[axisMap[2]] = normalPosition;
  return result;
}

/** Physical units per screen pixel in a slice view (uniform ortho scale). */
export function sliceUnitsPerPixel(state: State, viewportHeight: number): number {
  return cameraDistance(state.exploration.camera) / Math.max(viewportHeight, 1);
}

// ============================================================================
// VOLUME VIEWS (perspective at DEFAULT_FOV)
// ============================================================================

/**
 * Project a physical position into volume-view screen pixels.
 * Returns null when the point lies behind the camera.
 */
export function physicalToVolumeScreen(
  position : Vec3,
  camera   : { position: Vec3; target: Vec3; up?: Vec3 },
  width    : number,
  height   : number,
  fov      = DEFAULT_FOV,
): Vec2 | null {
  const { forward, right, up } = cameraBasis(camera);
  const relative: Vec3 = [
    position[0] - camera.position[0],
    position[1] - camera.position[1],
    position[2] - camera.position[2],
  ];
  const depth = dot(relative, forward);
  if (depth <= 1e-6) return null;
  const halfHeight = Math.max(depth * Math.tan(fov / 2), 1e-6);
  const halfWidth  = halfHeight * width / Math.max(height, 1);
  const clipX      = dot(relative, right) / halfWidth;
  const clipY      = -dot(relative, up) / halfHeight;
  return [(clipX * 0.5 + 0.5) * width, (clipY * 0.5 + 0.5) * height];
}

/** Unproject volume-view screen pixels onto the plane through the camera target. */
export function screenToVolumeTargetPlane(
  screenX : number,
  screenY : number,
  camera  : Camera,
  width   : number,
  height  : number,
): Vec3 {
  const { forward, right, up } = cameraBasis(camera);
  const clipX  = (screenX / Math.max(width, 1)) * 2 - 1;
  const clipY  = (screenY / Math.max(height, 1)) * 2 - 1;
  const aspect = width / Math.max(height, 1);
  const direction = normalize([
    forward[0] + right[0] * clipX * HALF_FOV_TAN * aspect - up[0] * clipY * HALF_FOV_TAN,
    forward[1] + right[1] * clipX * HALF_FOV_TAN * aspect - up[1] * clipY * HALF_FOV_TAN,
    forward[2] + right[2] * clipX * HALF_FOV_TAN * aspect - up[2] * clipY * HALF_FOV_TAN,
  ]);
  const targetOffset: Vec3 = [
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ];
  const distance = dot(targetOffset, forward) / Math.max(dot(direction, forward), 1e-6);
  return [
    camera.position[0] + direction[0] * distance,
    camera.position[1] + direction[1] * distance,
    camera.position[2] + direction[2] * distance,
  ];
}

/** Physical units per screen pixel at the target plane of a volume view. */
export function volumeUnitsPerPixel(camera: Camera, viewportHeight: number): number {
  return 2 * cameraDistance(camera) * HALF_FOV_TAN / Math.max(viewportHeight, 1);
}
