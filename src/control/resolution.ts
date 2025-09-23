/**
 * ResolutionControl - Manual LOD level stepping
 *
 * Supported DOM actions:
 * - key:down { code } — Minus/NumpadSubtract (coarser), Equal/NumpadAdd (finer)
 */

import type { State, Action } from "../types";
import { BaseControl } from "./base";

export class ResolutionControl extends BaseControl {
  static readonly controlType = "resolution";
  static create(id: string): ResolutionControl {
    return new ResolutionControl(id);
  }

  handle(action: Action, state: State): State {
    if (action.type !== "key:down") return state;

    const { code }= action.payload as { code: string };
    const lod     = state.exploration.lod;
    let level     = lod.level;

    switch (code) {
      case "Minus":
      case "NumpadSubtract":
        // Coarser: higher level number = lower resolution
        level = Math.max(0, Math.round(level + 1));
        break;
      case "Equal":
      case "NumpadAdd":
        // Finer: lower level number = higher resolution
        level = Math.max(0, Math.round(level - 1));
        break;
      default:
        return state;
    }

    if (state.exploration.lod.mode === "manual" && state.exploration.lod.level === level) {
      return state;
    }

    return {
      ...state,
      exploration: {
        ...state.exploration,
        lod: {
          ...state.exploration.lod,
          mode  : "manual",
          level,
        },
      },
    };
  }
}
