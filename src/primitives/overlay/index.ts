/**
 * Overlay Module
 */

import { overlayRegistry } from "../../registry";
import { CrosshairOverlay } from "./crosshair";
import { RulerOverlay } from "./ruler";
import { RoiSelectorOverlay } from "./roi-selector";
import { MagnifierOverlay } from "./magnifier/main";
import { FoldablePanelOverlay } from "./foldable-panel";

/**
 * Idempotent built-in bootstrap: registers the built-in overlay types in
 * `overlayRegistry`. Double-invocation is a no-op. Ordinary one-ID overlays
 * self-report through the static `OverlayClass.overlayType` contract; the
 * magnifier has no single identity — one implementation is parameterized by
 * dimension, so it registers `magnifier-2d` and `magnifier-3d` via explicit
 * factories instead.
 */
export function ensureBuiltInOverlays(): void {
  for (const cls of [
    CrosshairOverlay, RulerOverlay, RoiSelectorOverlay, FoldablePanelOverlay,
  ] as const) {
    if (!overlayRegistry.has(cls.overlayType)) {
      overlayRegistry.register(cls.overlayType, () => new cls());
    }
  }
  if (!overlayRegistry.has("magnifier-2d")) {
    overlayRegistry.register("magnifier-2d", () => new MagnifierOverlay("2d"));
  }
  if (!overlayRegistry.has("magnifier-3d")) {
    overlayRegistry.register("magnifier-3d", () => new MagnifierOverlay("3d"));
  }
}

export {
  BaseOverlay,
  type OverlayClass,
  type OverlayCornerPosition,
  type OverlayLabelVariant,
} from "./base";
export { CrosshairOverlay } from "./crosshair";
export { RulerOverlay } from "./ruler";
export {
  RoiSelectorOverlay,
  type RoiBox,
  type RoiChangeKind,
  type RoiChangePhase,
  type RoiSelectionChange,
  type RoiSelectionsChangeCallback,
  type RoiActiveIndexChangeCallback,
} from "./roi-selector";
export {
  MagnifierOverlay,
  type MagnifierDimension,
  type MagnifierOptions,
} from "./magnifier/main";
export { FoldablePanelOverlay } from "./foldable-panel";
export {
  type BaseOverlayOptions,
  type CrosshairOverlayOptions,
  type RulerOverlayOptions,
  type RoiSelectorOverlayOptions,
  type FoldablePanelOverlayOptions,
  type MagnifierOverlayOptions,
  type OverlayOptionsMap,
} from "./options";
