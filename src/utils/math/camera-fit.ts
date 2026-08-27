/**
 * Fit-to-data camera helpers — initial cameras that frame a PhysicalSpace.
 *
 * Pure math built on the public spherical helpers (`computePosition`,
 * `cameraDistance`); apps use these instead of open-coding center/extent
 * framing. All angles in radians.
 */

import type { Camera, PhysicalSpace, Vec3 } from "../../state/schema";
import type { AxisMap } from "./axes";
import { computePosition } from "./spherical";

// ============================================================================
// SHARED FRAMING
// ============================================================================

/** Center and max extent of a physical space's axis-aligned box. */
function spaceFraming(space: PhysicalSpace): { center: Vec3; maxExtent: number } {
  const { size, origin = [0, 0, 0] } = space.spatial;
  return {
    center: [
      origin[0] + size[0] / 2,
      origin[1] + size[1] / 2,
      origin[2] + size[2] / 2,
    ],
    maxExtent: Math.max(size[0], size[1], size[2], 1e-6),
  };
}

// ============================================================================
// VOLUME (perspective orbit)
// ============================================================================

export interface FrameVolumeCameraOptions {
  /** Distance from target, as a multiple of the space's max extent (default 1.5). */
  distanceFactor? : number;
  /** Orbit yaw in radians (default 0.5). */
  yaw?            : number;
  /** Orbit pitch in radians (default -0.4). */
  pitch?          : number;
  /** Navigation mode (default "orbit"). */
  navMode?        : Camera["navMode"];
  /** Projection mode (default "perspective"). */
  projMode?       : Camera["projMode"];
}

/**
 * Initial volume camera framing the whole physical space: target at the
 * space center, position pulled back along the given orbit angles at
 * `maxExtent × distanceFactor`.
 */
export function frameVolumeCamera(
  space: PhysicalSpace,
  opts: FrameVolumeCameraOptions = {},
): Camera {
  const { center, maxExtent } = spaceFraming(space);
  const distance = maxExtent * (opts.distanceFactor ?? 1.5);
  return {
    navMode  : opts.navMode ?? "orbit",
    projMode : opts.projMode ?? "perspective",
    target   : center,
    position : computePosition(center, distance, opts.yaw ?? 0.5, opts.pitch ?? -0.4),
  };
}

// ============================================================================
// SLICE (axis-aligned orthographic)
// ============================================================================

export interface FitSliceCameraOptions {
  /** Navigation mode (default "fly"). */
  navMode?  : Camera["navMode"];
  /** Projection mode (default "orthographic"). */
  projMode? : Camera["projMode"];
}

/**
 * Initial slice camera framing the plane given by `axisMap`: target at the
 * space center, position offset along the plane normal so the ortho
 * half-extent covers the plane's larger in-plane axis (slice views derive
 * their visible half-extent from the camera distance).
 */
export function fitSliceCamera(
  axisMap: AxisMap,
  space: PhysicalSpace,
  opts: FitSliceCameraOptions = {},
): Camera {
  const { center } = spaceFraming(space);
  const { size } = space.spatial;
  const distance = Math.max(size[axisMap[0]], size[axisMap[1]], 1e-6);
  const position = [...center] as Vec3;
  position[axisMap[2]] += distance;
  return {
    navMode  : opts.navMode ?? "fly",
    projMode : opts.projMode ?? "orthographic",
    target   : center,
    position,
  };
}
