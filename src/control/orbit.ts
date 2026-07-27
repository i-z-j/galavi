/**
 * OrbitControl - 3D orbital camera manipulation
 * 
 * Supported DOM actions:
 * - mouse:drag { dx, dy } - rotate around target
 * - mouse:wheel { delta, cursorX?, cursorY? } - zoom in/out
 */

import { vec3 } from "wgpu-matrix";
import type { State, Action, Vec3 } from "../types";
import {
  clampPitch,
  computePosition,
  cameraDistance,
  cameraAngles,
  optNumber
} from "../utils";
import {
  ZOOM_SENSITIVITY,
  ORBIT_SENSITIVITY,
  DEFAULT_FOV
} from "../defaults";
import { BaseControl, clampZoomDistance } from "./base";

export interface OrbitControlOptions {
  zoomSensitivity?  : number;
  orbitSensitivity? : number;
}

export class OrbitControl extends BaseControl {
  static readonly controlType = "orbit";
  static create(id: string, options?: OrbitControlOptions): OrbitControl {
    return new OrbitControl(id, options);
  }

  override readonly navMode = "orbit" as const;
  private readonly zoomSensitivity  : number;
  private readonly orbitSensitivity : number;

  constructor(id: string, options?: OrbitControlOptions) {
    super(id);
    this.zoomSensitivity  = optNumber(options?.zoomSensitivity)  ?? ZOOM_SENSITIVITY;
    this.orbitSensitivity = optNumber(options?.orbitSensitivity) ?? ORBIT_SENSITIVITY;
  }

  handle(action: Action, state: State): State {
    const cam           = state.exploration.camera;
    let target          = [...cam.target] as Vec3;
    let distance        = cameraDistance(cam);
    let { yaw, pitch }  = cameraAngles(cam);
    let updated         = false;
    const maxExtent     = Math.max(...(state.physical?.spatial?.size ?? [1, 1, 1]));

    switch (action.type) {
      case "mouse:drag": {
        const { dx, dy, axisMap } = action.payload as { dx: number; dy: number; axisMap?: unknown };
        if (axisMap) break; // 2D drags go to PanZoomControl
        yaw    += dx * this.orbitSensitivity;
        pitch   = clampPitch(pitch + dy * this.orbitSensitivity);
        updated = true;
        break;
      }

      case "mouse:wheel": {
        const { delta, cursorX, cursorY, axisMap } = action.payload as {
          delta     : number;
          cursorX?  : number;
          cursorY?  : number;
          axisMap?  : unknown;
        };
        if (axisMap) break; // 2D zooms go to PanZoomControl

        const newDistance = clampZoomDistance(distance, delta, this.zoomSensitivity, maxExtent);

        // Zoom at cursor: adjust target to keep cursor's world position stable
        if (cursorX !== undefined && cursorY !== undefined) {
          const fov         = DEFAULT_FOV;
          const tanHalfFov  = Math.tan(fov / 2);
          const ndcX        = cursorX * 2 - 1;
          const ndcY        = cursorY * 2 - 1;

          const forward = vec3.normalize(vec3.subtract(target, cam.position));
          const right   = vec3.normalize(vec3.cross([0, 1, 0], vec3.negate(forward)));
          const upV     = vec3.cross(vec3.negate(forward), right);

          const oldOffsetX      = ndcX * distance * tanHalfFov;
          const oldOffsetY      = ndcY * distance * tanHalfFov;
          const oldCursorWorld  = vec3.add(
            target,
            vec3.add(vec3.scale(right, oldOffsetX), vec3.scale(upV, oldOffsetY))
          );

          const newOffsetX      = ndcX * newDistance * tanHalfFov;
          const newOffsetY      = ndcY * newDistance * tanHalfFov;
          const newCursorWorld  = vec3.add(
            target,
            vec3.add(vec3.scale(right, newOffsetX), vec3.scale(upV, newOffsetY))
          );

          const drift = vec3.subtract(oldCursorWorld, newCursorWorld);
          target = vec3.add(target, drift) as Vec3;
        }

        distance  = newDistance;
        updated   = true;
        break;
      }
    }

    if (!updated) return state;

    const position = computePosition(target, distance, yaw, pitch);
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


