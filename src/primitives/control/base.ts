/**
 * Controls Base Module
 *
 * Controls are pure reducer:
 *   (action + state) => updated state
 *
 * BaseControl — abstract base for state-transforming controls.
 */

import type { State, Action, ID } from "../../state/schema";
import { MIN_DISTANCE_FACTOR, MAX_DISTANCE_FACTOR } from "../../defaults";

// ============================================================================
// BASE CONTROL
// ============================================================================

/**
 * Static contract for control classes registered via `controlRegistry`. Each
 * concrete control declares its own `controlType` string and `create` factory,
 * so `registry.ts` collapses to a simple iteration over the class list.
 */
export interface ControlClass {
  readonly controlType: string;
  create(id: ID, options?: Record<string, unknown>): BaseControl;
}

export abstract class BaseControl {
  readonly id: ID;

  /** If set, this control is a nav control for the given navigation mode. */
  readonly navMode?: "orbit" | "fly";

  constructor(id: ID) {
    this.id = id;
  }

  abstract handle(action: Action, state: State): State;
}

/**
 * Apply a wheel-delta exponential zoom to a camera distance, clamped against
 * the scene-relative MIN/MAX distance factors. Shared by orbit + panzoom.
 */
export function clampZoomDistance(
  current     : number,
  delta       : number,
  sensitivity : number,
  maxExtent   : number,
): number {
  return Math.max(
    maxExtent * MIN_DISTANCE_FACTOR,
    Math.min(
      maxExtent * MAX_DISTANCE_FACTOR,
      current * Math.pow(sensitivity, delta),
    ),
  );
}
