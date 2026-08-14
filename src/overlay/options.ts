/**
 * Typed option bags for the built-in overlays (DX-Q4).
 *
 * `OverlayOptionsMap` maps each built-in overlay type string to the options
 * interface its `setOptions` understands (the subclass-specific keys plus the
 * base `visible` / `visibleWhenActive` / `theme` keys every overlay accepts).
 * It types `ViewConfig.overlays` and `ViewAccessor.setOverlayOptions`; custom
 * overlay types registered via `registerOverlay` keep the untyped
 * `Record<string, unknown>` escape hatch.
 */

import type { Vec3 } from "../types";
import type { DeepPartial, GalaviTheme } from "./theme";
import type { MagnifierOptions } from "./magnifier";
import type {
  RoiActiveIndexChangeCallback,
  RoiBox,
  RoiSelectionsChangeCallback,
} from "./roi-selector";

/** Options accepted by every overlay (applied by `BaseOverlay.setOptions`). */
export interface BaseOverlayOptions {
  /** Show/hide the overlay (default: true). */
  visible?           : boolean;
  /** Render only while the bound view is the active view (default: false). */
  visibleWhenActive? : boolean;
  /**
   * Stacking order of the overlay root (default: 10). Raise it when the app
   * floats its own chrome above the viewer (e.g. `z-index: 20` HUD panels)
   * that would otherwise cover and event-occlude interactive overlay UI such
   * as the 3D magnifier's channel panel.
   */
  zIndex?            : number;
  /** Per-overlay theme override, merged over the global galavi theme. */
  theme?             : DeepPartial<GalaviTheme>;
}

/** Options for the built-in `"crosshair"` overlay. */
export interface CrosshairOverlayOptions extends BaseOverlayOptions {
  /** Target point in physical coordinates (defaults to the camera target). */
  position?  : Vec3;
  /** Stroke width in px (default: 1). */
  lineWidth? : number;
}

/** Options for the built-in `"ruler"` overlay. */
export interface RulerOverlayOptions extends BaseOverlayOptions {
  /** Unit label override (defaults to the state's physical unit). */
  unit?       : string;
  /** Stroke width in px (default: 1). */
  lineWidth?  : number;
  /** Change to a new number to reset the ruler to its default segment. */
  resetNonce? : number;
}

/** Options for the built-in `"roiselector"` overlay. */
export interface RoiSelectorOverlayOptions extends BaseOverlayOptions {
  /** ROI boxes in physical coordinates. */
  rois?                : RoiBox[];
  /** Index of the active ROI, or null for none. */
  activeIndex?         : number | null;
  /** Whether pointer interaction creates/edits ROIs (default: true). */
  enabled?             : boolean;
  onRoisChange?        : RoiSelectionsChangeCallback;
  onActiveIndexChange? : RoiActiveIndexChangeCallback;
}

/** Options for the built-in `"foldablepanel"` overlay. */
export interface FoldablePanelOverlayOptions extends BaseOverlayOptions {
  /** Edge to dock to (default: "left"). */
  side?         : "left" | "right";
  /** Panel open state (default: true). */
  open?         : boolean;
  /** Panel width in px (default: 300). */
  width?        : number;
  /** Header micro-label (default: "panel"). */
  label?        : string;
  /** Offset from host top in px (default: 0). */
  top?          : number;
  /** Offset from host bottom in px (default: 0). */
  bottom?       : number;
  /** Element appended into the panel body; replaced when a new one arrives. */
  content?      : HTMLElement;
  /** Fired on user toggles only. */
  onOpenChange? : (open: boolean) => void;
}

/** Options for the built-in `"magnifier-2d"` / `"magnifier-3d"` overlays. */
export interface MagnifierOverlayOptions extends MagnifierOptions, BaseOverlayOptions {}

/**
 * Built-in overlay type string → its options interface. Custom overlay types
 * registered via `registerOverlay` are intentionally absent — callers use the
 * `Record<string, unknown>` escape hatch for those.
 */
export interface OverlayOptionsMap {
  "crosshair"     : CrosshairOverlayOptions;
  "ruler"         : RulerOverlayOptions;
  "roiselector"   : RoiSelectorOverlayOptions;
  "foldablepanel" : FoldablePanelOverlayOptions;
  "magnifier-2d"  : MagnifierOverlayOptions;
  "magnifier-3d"  : MagnifierOverlayOptions;
}
