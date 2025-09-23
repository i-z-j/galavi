/**
 * Input Normalization — device-agnostic intent values from browser events.
 *
 * Views call these before dispatching actions. Controls receive normalized
 * semantic values instead of raw browser-specific deltas.
 *
 * Normalized units:
 * - Zoom: "notches" — 1.0 = one discrete scroll step (regardless of device)
 * - Drag: fraction of viewport — 1.0 = full canvas width/height
 */

// ============================================================================
// WHEEL NORMALIZATION
// ============================================================================

/**
 * Normalize a WheelEvent into device-agnostic scroll "notches".
 *
 * One notch ≈ one discrete mouse wheel click ≈ one trackpad scroll gesture step.
 * Result magnitude is typically in [0.1, 3.0] per event.
 *
 * Handles:
 * - deltaMode (pixel / line / page)
 * - macOS trackpad continuous scrolling (many small pixel deltas)
 * - Windows/Linux discrete wheel (large 120px jumps)
 * - High-DPI pixel scaling
 */
export function normalizeWheel(event: WheelEvent): number {
  let delta = event.deltaY;

  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_PIXEL:
      // Pixel deltas — normalize to notches.
      // Discrete mouse wheels typically emit ±120px per click (Windows)
      // or ±4–12px per click (macOS). Trackpads emit many small values.
      // Use 120 as the reference: one notch = 120 pixels.
      delta /= 120;
      break;

    case WheelEvent.DOM_DELTA_LINE:
      // Line deltas — Firefox wheel events. ~3 lines ≈ 1 notch.
      delta /= 3;
      break;

    case WheelEvent.DOM_DELTA_PAGE:
      // Page deltas — rare, treat 1 page ≈ 10 notches.
      delta *= 10;
      break;
  }

  return delta;
}

// ============================================================================
// DRAG NORMALIZATION
// ============================================================================

/**
 * Normalize a pointer drag delta from raw pixels to viewport-fraction units.
 *
 * Returns { dx, dy } where 1.0 = full canvas dimension.
 * Accounts for devicePixelRatio so behavior is consistent across HiDPI screens.
 */
export function normalizeDrag(
  rawDx: number,
  rawDy: number,
  canvasWidth: number,
  canvasHeight: number,
): { dx: number; dy: number } {
  // Canvas clientWidth/Height are CSS pixels, not physical pixels.
  // Raw mouse deltas are already in CSS pixels, so no DPI correction needed
  // when dividing by CSS dimensions. This produces consistent viewport-fraction
  // values regardless of devicePixelRatio.
  return {
    dx: canvasWidth > 0 ? rawDx / canvasWidth : 0,
    dy: canvasHeight > 0 ? rawDy / canvasHeight : 0,
  };
}
