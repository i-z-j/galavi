/**
 * Control Module
 */

import { controlRegistry, type ControlFactory } from "../../registry";
import { OrbitControl } from "./orbit";
import { FlyControl } from "./fly";
import { PanZoomControl } from "./panzoom";

/**
 * Idempotent built-in bootstrap: registers the three built-in control types
 * in `controlRegistry`. Double-invocation is a no-op.
 */
export function ensureBuiltInControls(): void {
  for (const cls of [OrbitControl, FlyControl, PanZoomControl] as const) {
    if (!controlRegistry.has(cls.controlType)) {
      controlRegistry.register(cls.controlType, cls.create.bind(cls) as ControlFactory);
    }
  }
}

export {
  BaseControl,
  type ControlClass,
} from "./base";
export {
  OrbitControl,
  type OrbitControlOptions
} from "./orbit";
export {
  FlyControl,
  type FlyControlOptions,
} from "./fly";
export {
  PanZoomControl,
  type PanZoomControlOptions
} from "./panzoom";
