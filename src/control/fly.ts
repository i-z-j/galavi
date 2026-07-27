/**
 * FlyControl - 3D first-person style camera manipulation
 *
 * Supported DOM actions:
 * - mouse:drag { dx, dy } - rotate fly orientation
 * - key:down { code, shift?, ctrl? } - one-shot keys
 * - key:held { codes, dt } - continuous movement (WASD/arrows, QE vertical)
 *
 * Built-in key bindings:
 * - WASD / Arrows: forward/strafe
 * - Q/E: up/down
 */

import { vec3 } from "wgpu-matrix";
import type { State, Action, Vec3 } from "../types";
import {
  clampPitch,
  computeForward,
  cameraDistance,
  cameraAngles,
  optNumber
} from "../utils";
import {
  FLY_MOVE_SPEED,
  FLY_LOOK_SENSITIVITY,
  FLY_MIN_DISTANCE
} from "../defaults";
import { BaseControl } from "./base";

export interface FlyControlOptions {
  moveSpeed?        : number;
  lookSensitivity?  : number;
}

export class FlyControl extends BaseControl {
  static readonly controlType = "fly";
  static create(id: string, options?: FlyControlOptions): FlyControl {
    return new FlyControl(id, options);
  }

  override readonly navMode = "fly" as const;
  private readonly moveSpeed        : number;
  private readonly lookSensitivity  : number;

  constructor(id: string, options?: FlyControlOptions) {
    super(id);
    this.moveSpeed        = optNumber(options?.moveSpeed)       ?? FLY_MOVE_SPEED;
    this.lookSensitivity  = optNumber(options?.lookSensitivity) ?? FLY_LOOK_SENSITIVITY;
  }

  handle(action: Action, state: State): State {
    const cam           = state.exploration.camera;
    let target          = [...cam.target] as Vec3;
    let position        = [...cam.position] as Vec3;
    let { yaw, pitch }  = cameraAngles(cam);
    let distance        = cameraDistance(cam);
    let updated         = false;

    switch (action.type) {
      case "mouse:drag": {
        const { dx, dy, axisMap } = action.payload as { dx: number; dy: number; axisMap?: unknown };
        if (axisMap) break; // 2D drags go to PanZoomControl
        yaw    += dx * this.lookSensitivity;
        pitch   = clampPitch(pitch + dy * this.lookSensitivity);
        const forward = computeForward(yaw, pitch);
        target  = vec3.add(position, vec3.scale(forward, distance)) as Vec3;
        updated = true;
        break;
      }

      case "key:held": {
        const { codes, dt } = action.payload as { codes: string[]; dt: number };

        const forward   = computeForward(yaw, pitch);
        const right     = vec3.normalize(vec3.cross([0, 1, 0], vec3.negate(forward)));
        const up        = [0, 1, 0] as Vec3;
        const step      = this.moveSpeed * Math.max(distance, FLY_MIN_DISTANCE) * (dt / (1 / 60)); // normalize to ~60fps
        const movement  = vec3.create();

        for (const code of codes) {
          switch (code) {
            case "KeyW": case "ArrowUp":
              vec3.addScaled(movement, forward, step, movement); break;
            case "KeyS": case "ArrowDown":
              vec3.addScaled(movement, forward, -step, movement); break;
            case "KeyD": case "ArrowRight":
              vec3.addScaled(movement, right, step, movement); break;
            case "KeyA": case "ArrowLeft":
              vec3.addScaled(movement, right, -step, movement); break;
            case "KeyE":
              vec3.addScaled(movement, up, step, movement); break;
            case "KeyQ":
              vec3.addScaled(movement, up, -step, movement); break;
          }
        }

        if (vec3.length(movement) > 0) {
          position = vec3.add(position, movement) as Vec3;
          target   = vec3.add(target, movement) as Vec3;
          updated  = true;
        }
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