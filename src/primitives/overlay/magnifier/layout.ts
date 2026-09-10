/**
 * Pure magnifier screen-space layout: inset placement around the source
 * rectangle, edge clamping against the projected image bounds, channel-panel
 * reservation, and connector-corner selection with switch hysteresis. No DOM,
 * no callbacks, no runtime state.
 */

import { clamp } from "../utils";

const FRAME_GAP = 16;
const PANEL_GAP = 0;
const CORNER_SWITCH_HYSTERESIS = 4;
const GAP_EPSILON = 0.5;

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ScreenPoint { x: number; y: number }
type PanelSide = "left" | "right";

export interface MagnifierLayout {
  source           : ScreenRect;
  inset            : ScreenRect;
  connector        : { from: ScreenPoint; to: ScreenPoint };
  connectorCorners : readonly [number, number];
  placement        : number;
  panelSide        : PanelSide;
}

export function rectWidth(rect: ScreenRect): number { return rect.right - rect.left; }
export function rectHeight(rect: ScreenRect): number { return rect.bottom - rect.top; }
function rectCenterX(rect: ScreenRect): number { return (rect.left + rect.right) / 2; }
function rectCenterY(rect: ScreenRect): number { return (rect.top + rect.bottom) / 2; }

export function makeRect(left: number, top: number, size: number): ScreenRect {
  return { left, top, right: left + size, bottom: top + size };
}

function rectCorners(rect: ScreenRect): ScreenPoint[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.left, y: rect.bottom },
    { x: rect.right, y: rect.bottom },
  ];
}

function overflow(rect: ScreenRect, bounds: ScreenRect): number {
  return (
    Math.max(bounds.left - rect.left, 0) +
    Math.max(rect.right - bounds.right, 0) +
    Math.max(bounds.top - rect.top, 0) +
    Math.max(rect.bottom - bounds.bottom, 0)
  );
}

function panelSideFor(source: ScreenRect, inset: ScreenRect): PanelSide {
  return rectCenterX(inset) >= rectCenterX(source) ? "right" : "left";
}

function framedInset(inset: ScreenRect, side: PanelSide, panelWidth: number): ScreenRect {
  if (panelWidth <= 0) return inset;
  return side === "right"
    ? { ...inset, right: inset.right + PANEL_GAP + panelWidth }
    : { ...inset, left: inset.left - PANEL_GAP - panelWidth };
}

function clampInset(
  candidate: ScreenRect,
  bounds: ScreenRect,
  size: number,
  side: PanelSide,
  panelWidth: number,
): ScreenRect {
  const reserveLeft = side === "left" ? panelWidth + PANEL_GAP : 0;
  const reserveRight = side === "right" ? panelWidth + PANEL_GAP : 0;
  let minLeft = bounds.left + reserveLeft;
  let maxLeft = bounds.right - size - reserveRight;
  if (maxLeft < minLeft) {
    minLeft = bounds.left;
    maxLeft = bounds.right - size;
  }
  return makeRect(
    clamp(candidate.left, minLeft, maxLeft),
    clamp(candidate.top, bounds.top, bounds.bottom - size),
    size,
  );
}

function keepsFrameGap(source: ScreenRect, inset: ScreenRect): boolean {
  const horizontalGap = Math.max(inset.left - source.right, source.left - inset.right, 0);
  const verticalGap = Math.max(inset.top - source.bottom, source.top - inset.bottom, 0);
  return horizontalGap >= FRAME_GAP - GAP_EPSILON || verticalGap >= FRAME_GAP - GAP_EPSILON;
}

function cornerDistance(first: ScreenPoint, second: ScreenPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function closestCorners(
  first: ScreenRect,
  second: ScreenRect,
  previous: readonly [number, number] | undefined,
): Pick<MagnifierLayout, "connector" | "connectorCorners"> {
  const firstCorners = rectCorners(first);
  const secondCorners = rectCorners(second);
  let bestCorners: readonly [number, number] = [0, 0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < firstCorners.length; firstIndex++) {
    for (let secondIndex = 0; secondIndex < secondCorners.length; secondIndex++) {
      const dx = secondCorners[secondIndex].x - firstCorners[firstIndex].x;
      const dy = secondCorners[secondIndex].y - firstCorners[firstIndex].y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCorners = [firstIndex, secondIndex];
      }
    }
  }
  if (previous) {
    const previousDistance = cornerDistance(firstCorners[previous[0]], secondCorners[previous[1]]);
    if (previousDistance <= Math.sqrt(bestDistance) + CORNER_SWITCH_HYSTERESIS) {
      bestCorners = previous;
    }
  }
  return {
    connector: { from: firstCorners[bestCorners[0]], to: secondCorners[bestCorners[1]] },
    connectorCorners: bestCorners,
  };
}

export function layoutMagnifier(
  source: ScreenRect,
  bounds: ScreenRect,
  insetSize: number,
  panelWidth: number,
  previousPlacement: number | undefined,
  previousConnectorCorners: readonly [number, number] | undefined,
): MagnifierLayout {
  const centerX = rectCenterX(source);
  const centerY = rectCenterY(source);
  const candidates = [
    makeRect(source.right + FRAME_GAP, source.top - FRAME_GAP - insetSize, insetSize),
    makeRect(centerX - insetSize / 2, source.top - FRAME_GAP - insetSize, insetSize),
    makeRect(source.right + FRAME_GAP, centerY - insetSize / 2, insetSize),
    makeRect(source.left - FRAME_GAP - insetSize, source.top - FRAME_GAP - insetSize, insetSize),
    makeRect(source.right + FRAME_GAP, source.bottom + FRAME_GAP, insetSize),
    makeRect(source.left - FRAME_GAP - insetSize, centerY - insetSize / 2, insetSize),
    makeRect(centerX - insetSize / 2, source.bottom + FRAME_GAP, insetSize),
    makeRect(source.left - FRAME_GAP - insetSize, source.bottom + FRAME_GAP, insetSize),
  ];
  const resolved = candidates.map((candidate) => {
    const side = panelSideFor(source, candidate);
    const inset = clampInset(candidate, bounds, insetSize, side, panelWidth);
    return { inset, side, score: overflow(framedInset(candidate, side, panelWidth), bounds) };
  });
  let placement = 0;
  if (
    previousPlacement !== undefined && resolved[previousPlacement] &&
    keepsFrameGap(source, resolved[previousPlacement].inset)
  ) {
    placement = previousPlacement;
  } else {
    for (let index = 1; index < resolved.length; index++) {
      if (resolved[index].score < resolved[placement].score) placement = index;
    }
  }
  const { inset, side } = resolved[placement];
  return {
    source,
    inset,
    placement,
    panelSide: side,
    ...closestCorners(source, inset, previousConnectorCorners),
  };
}
