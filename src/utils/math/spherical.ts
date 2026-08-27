/**
 * Spherical camera math — pitch clamping, distance, angles, position, forward.
 *
 * These are pure state functions used by controls.
 * GPU projection code lives in view/base.ts.
 */

import { vec3 } from "wgpu-matrix";
import type { Camera, Vec3 } from "../../state/schema";
import { PITCH_EPSILON } from "../../defaults";

// ============================================================================
// PITCH CLAMPING
// ============================================================================

const MIN_PITCH = -Math.PI / 2 + PITCH_EPSILON;
const MAX_PITCH = Math.PI / 2 - PITCH_EPSILON;

export function clampPitch(pitch: number): number {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));
}

// ============================================================================
// CAMERA MATH
// ============================================================================

/** Compute distance between camera position and target */
export function cameraDistance(cam: Camera): number {
  return Math.max(1e-6, vec3.distance(cam.position, cam.target));
}

/** Compute yaw and pitch from position-target vector (for orbit math) */
export function cameraAngles(cam: Camera): { yaw: number; pitch: number } {
  const dx = cam.position[0] - cam.target[0];
  const dy = cam.position[1] - cam.target[1];
  const dz = cam.position[2] - cam.target[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const pitch = dist > 1e-12 ? Math.asin(dy / dist) : 0;
  const yaw = Math.atan2(dx, dz);
  return { yaw, pitch };
}

/** Compute position from spherical parameters (target + distance + yaw + pitch) */
export function computePosition(
  target: Vec3,
  distance: number,
  yaw: number,
  pitch: number,
): Vec3 {
  const cosPitch = Math.cos(pitch);
  const dir = vec3.create(
    cosPitch * Math.sin(yaw),
    Math.sin(pitch),
    cosPitch * Math.cos(yaw),
  );
  const result = vec3.addScaled(target, dir, distance, vec3.create());
  return [result[0], result[1], result[2]];
}

/** Compute forward direction from yaw and pitch */
export function computeForward(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  const dir = vec3.normalize(vec3.create(
    -cosPitch * Math.sin(yaw),
    -Math.sin(pitch),
    -cosPitch * Math.cos(yaw),
  ));
  return [dir[0], dir[1], dir[2]];
}
