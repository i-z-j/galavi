/**
 * Overlay Module
 */

export {
  BaseOverlay,
  type OverlayClass,
  type OverlayCornerPosition,
  type OverlayLabelVariant,
} from "./base";
export { CrosshairOverlay } from "./crosshair";
export { RulerOverlay } from "./ruler";
export { RoiSelectorOverlay, type RoiBox, type RoiChangeCallback } from "./roi-selector";
export { MagnifierOverlay } from "./magnifier";
export { FoldablePanelOverlay } from "./foldable-panel";
