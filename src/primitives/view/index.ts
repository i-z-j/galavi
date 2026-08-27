/**
 * View Module
 *
 * Public extension surface for views, plus the idempotent built-in bootstrap
 * ({@link ensureBuiltInViews}) that fills `viewRegistry` — invoked by the
 * resolution boundaries (`createViewerRuntime`), never at import time. The
 * `runtime/` subfolder (image pipeline, scene uniform layout) is internal
 * machinery — imported directly by concrete views, not re-exported here.
 */

import { viewRegistry, type ViewFactory } from "../../registry";
import { VolumeView } from "./volume";
import { SliceView } from "./slice";
import { NavigatorView } from "./navigator";

/**
 * Idempotent built-in bootstrap: registers the three built-in view types in
 * `viewRegistry`. Double-invocation is a no-op.
 */
export function ensureBuiltInViews(): void {
  for (const cls of [VolumeView, SliceView, NavigatorView] as const) {
    if (!viewRegistry.has(cls.viewType)) {
      viewRegistry.register(cls.viewType, ((id: string) => new cls(id)) as ViewFactory);
    }
  }
}

export { BaseView, type ViewClass, type ViewOwner } from "./base";
export { VolumeView } from "./volume";
export { SliceView } from "./slice";
export { NavigatorView } from "./navigator";
