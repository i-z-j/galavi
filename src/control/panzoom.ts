/**
 * PanZoomControl - 2D pan and zoom for orthographic views
 *
 * Supported DOM actions:
 * - mouse:drag { dx, dy, axisMap } - pan view
 * - mouse:wheel { delta, cursorX?, cursorY?, axisMap } - zoom
 * - mouse:dblclick { x, y, axisMap } - set target to clicked position
 */

import type { State, Action, Vec3 } from "../types";
import { cameraDistance, optNumber, type AxisMap } from "../utils";
import {
  ZOOM_SENSITIVITY,
} from "../defaults";
import { BaseControl, clampZoomDistance } from "./base";

export interface PanZoomControlOptions {
  zoomSensitivity?: number;
}

export class PanZoomControl extends BaseControl {
  static readonly controlType = "panzoom";
  static create(id: string, options?: PanZoomControlOptions): PanZoomControl {
    return new PanZoomControl(id, options);
  }

  private readonly zoomSensitivity: number;

  constructor(id: string, options?: PanZoomControlOptions) {
    super(id);
    this.zoomSensitivity = optNumber(options?.zoomSensitivity) ?? ZOOM_SENSITIVITY;
  }

  handle(action: Action, state: State): State {
    const cam       = state.exploration.camera;
    let target      = [...cam.target] as Vec3;
    let position    = [...cam.position] as Vec3;
    let distance    = cameraDistance(cam);
    const sceneSize = (state.physical?.spatial?.size ?? [1, 1, 1]) as Vec3;
    const maxExtent = Math.max(...sceneSize);
    let updated     = false;

    switch (action.type) {
      case "mouse:drag": {
        const { dx, dy, axisMap } = action.payload as {
          dx        : number;
          dy        : number;
          aspect?   : number;
          axisMap?  : AxisMap;
        };

        // Only handle 2D drags (with axis map);
        if (!axisMap) break;
        const aspect = Math.max((action.payload as { aspect?: number }).aspect ?? 1, 1e-6);

        // Horizontal span grows with aspect in ortho views, so X pan must match it.
        target[axisMap[0]]    -= dx * distance * aspect;
        target[axisMap[1]]    -= dy * distance;
        position[axisMap[0]]  -= dx * distance * aspect;
        position[axisMap[1]]  -= dy * distance;

        // Clamp target within scene bounds
        target = clampTarget(distance, target, sceneSize, axisMap, aspect) as Vec3;
        // Keep position in sync — maintain same offset
        const offset = [
          cam.position[0] - cam.target[0],
          cam.position[1] - cam.target[1],
          cam.position[2] - cam.target[2],
        ] as Vec3;
        position = [target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]] as Vec3;
        updated = true;
        break;
      }

      case "mouse:wheel": {
        const { delta, cursorX, cursorY, axisMap } = action.payload as {
          delta     : number;
          cursorX?  : number;
          cursorY?  : number;
          aspect?   : number;
          axisMap?  : AxisMap;
        };

        // Only handle 2D zooms (with axis map);
        if (!axisMap) break;
        const aspect = Math.max((action.payload as { aspect?: number }).aspect ?? 1, 1e-6);

        // Compute new distance (larger = zoomed out, smaller = zoomed in)
        const newDistance = clampZoomDistance(distance, delta, this.zoomSensitivity, maxExtent);

        // Zoom at cursor: adjust target to keep cursor's world position stable
        if (cursorX !== undefined && cursorY !== undefined && newDistance !== distance) {
          const clipX = cursorX * 2 - 1;
          const clipY = cursorY * 2 - 1;

          // halfExtent = distance / 2 for ortho views, with aspect-scaled horizontal span.
          target[axisMap[0]] += clipX * (distance - newDistance) * aspect / 2;
          target[axisMap[1]] += clipY * (distance - newDistance) / 2;
        }

        // Move position along view direction to achieve new distance
        const dir = [
          cam.position[0] - cam.target[0],
          cam.position[1] - cam.target[1],
          cam.position[2] - cam.target[2],
        ] as Vec3;
        const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
        const norm = len > 0 ? [dir[0] / len, dir[1] / len, dir[2] / len] as Vec3 : [0, 0, 1] as Vec3;
        position = [
          target[0] + norm[0] * newDistance,
          target[1] + norm[1] * newDistance,
          target[2] + norm[2] * newDistance,
        ] as Vec3;

        target = clampTarget(newDistance, target, sceneSize, axisMap, aspect) as Vec3;
        // Recompute position after clamp
        position = [
          target[0] + norm[0] * newDistance,
          target[1] + norm[1] * newDistance,
          target[2] + norm[2] * newDistance,
        ] as Vec3;
        updated = true;
        break;
      }

      case "mouse:dblclick": {
        const { x, y, axisMap } = action.payload as {
          x         : number;
          y         : number;
          aspect?   : number;
          axisMap?  : AxisMap;
        };

        if (!axisMap) break;
        const aspect = Math.max((action.payload as { aspect?: number }).aspect ?? 1, 1e-6);

        // Convert normalized [0,1] click coords to world-space target.
        // halfExtent = distance / 2 (same ortho framing as zoom).
        const half = distance / 2;
        const offset = [
          cam.position[0] - cam.target[0],
          cam.position[1] - cam.target[1],
          cam.position[2] - cam.target[2],
        ] as Vec3;

        target[axisMap[0]] = cam.target[axisMap[0]] + (x * 2 - 1) * half * aspect;
        target[axisMap[1]] = cam.target[axisMap[1]] + (y * 2 - 1) * half;
        // axisMap[2] (slice depth) stays unchanged

        target = clampTarget(distance, target, sceneSize, axisMap, aspect) as Vec3;
        position = [target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]] as Vec3;
        updated = true;
        break;
      }
    }

    if (!updated) return state;

    return {
      ...state,
      exploration: {
        ...state.exploration,
        camera: {
          ...state.exploration.camera,
          target,
          position,
        },
      },
    };
  }
}

// --- Helpers ---

/**
 * Clamp target so the content stays within the viewport.
 * Scene bounds are assumed to be [0, size[axis]] per axis.
 *
 * When zoomed in  (zoom >= 1): viewport is smaller than content,
 *   so target.axis ∈ [halfView, extent - halfView] — keeps viewport inside content.
 *
 * When zoomed out (zoom < 1): viewport is larger than content,
 *   so target.axis ∈ [extent - halfView, halfView] — keeps content inside viewport
 *   (the range is inverted, meaning target is clamped toward center).
 */
function clampTarget(distance: number, target: Vec3, size: Vec3, axisMap: AxisMap, aspect: number): Vec3 {
  const halfY = distance / 2;
  const halfX = halfY * aspect;
  const clamped = [...target] as Vec3;
  clamped[axisMap[0]] = clampAxis(target[axisMap[0]], halfX, size[axisMap[0]]);
  clamped[axisMap[1]] = clampAxis(target[axisMap[1]], halfY, size[axisMap[1]]);
  return clamped;
}

function clampAxis(value: number, halfView: number, size: number): number {
  const lo = halfView;
  const hi = size - halfView;
  if (lo <= hi) {
    // Zoomed in: clamp target within [lo, hi]
    return Math.max(lo, Math.min(hi, value));
  }
  // Zoomed out: viewport wider than content, lock to center
  return size / 2;
}
