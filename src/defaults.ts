/**
 * Global default values and state normalization.
 */

import type {
  Exploration,
  State,
  Vec3,
} from "./types";

// ============================================================================
// CONTROL SENSITIVITIES
//
// All values are in semantic units after input normalization:
// - Zoom: "notches" (1.0 = one discrete scroll step, device-agnostic)
// - Drag: viewport-fraction (1.0 = full canvas width/height)
// - Fly move: world-units per frame (scaled by distance)
// ============================================================================

/** Distance multiplier per scroll notch. 1.2 = 20% zoom per step. */
export const ZOOM_SENSITIVITY      = 1.2;

/** Orbit rotation per viewport-fraction (radians). Full drag ≈ 2.5 rotations. */
export const ORBIT_SENSITIVITY     = 16;

/** Fly movement speed per frame (fraction of distance). */
export const FLY_MOVE_SPEED        = 0.015;

/** Fly look rotation per viewport-fraction (radians). Same scale as orbit. */
export const FLY_LOOK_SENSITIVITY  = 16;

export const FLY_MIN_DISTANCE      = 0.01;
export const MIN_DISTANCE_FACTOR   = 1 / 1000;
export const MAX_DISTANCE_FACTOR   = 1.5;

// ============================================================================
// CAMERA CONSTANTS
// ============================================================================

export const DEFAULT_FOV      = Math.PI / 4;
export const NEAR_CLIP_FACTOR = 0.0001;
export const FAR_CLIP_FACTOR  = 100;
export const PITCH_EPSILON    = 0.01; // to avoid gimbal lock at poles

// ============================================================================
// VIEW CONSTANTS
// ============================================================================

export const DEPTH_FORMAT           = "depth24plus" as GPUTextureFormat;
export const COLORMAP_TEXTURE_WIDTH = 256;
export const MODE_TRANSITION_MS     = 240;
/** Volume ray step in normalized viewport space. */
export const VOLUME_STEP_SIZE = 0.008;
/** Approximate samples across one viewport axis; caps useful 3D resolution. */
export const VOLUME_RAY_SAMPLE_COUNT = Math.floor(1 / VOLUME_STEP_SIZE);

/** Default auto-rotate speed (degrees per second) for volume views. */
export const AUTO_ROTATE_SPEED_DEG_PER_SEC = 20;

// ============================================================================
// INTERACTION CONSTANTS
// ============================================================================

export const CLICK_PIXEL_THRESHOLD    = 4;
export const CLICK_TIME_THRESHOLD_MS  = 300;

// ============================================================================
// NAVIGATOR CONSTANTS
// ============================================================================

/** Framing margin for navigator overview camera */
export const NAVIGATOR_FRAMING_MARGIN = 1.15;

// ============================================================================
// CAMERA DEFAULTS
// ============================================================================

export const DEFAULT_CAMERA_NAV_MODE       = "orbit";
export const DEFAULT_CAMERA_PROJ_MODE      = "perspective";
export const DEFAULT_CAMERA_POSITION: Vec3 = [1.13, 0.12, 1.13];
export const DEFAULT_CAMERA_TARGET  : Vec3 = [0.5, 0.5, 0.5];

// ============================================================================
// COMPOSED DEFAULTS
// ============================================================================

/** Default exploration state — centered view of full normalized volume */
export const DEFAULT_EXPLORATION: Exploration = {
  camera: {
    navMode   : DEFAULT_CAMERA_NAV_MODE,
    projMode  : DEFAULT_CAMERA_PROJ_MODE,
    position  : DEFAULT_CAMERA_POSITION,
    target    : DEFAULT_CAMERA_TARGET,
  },
};

export const DEFAULT_STATE: State = {
  exploration : DEFAULT_EXPLORATION,
  layers      : [],
};
