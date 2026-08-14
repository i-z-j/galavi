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
} from "./magnifier";
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
