/**
 * Overlay utils — shared DOM/SVG helpers for overlay implementations.
 */

import type { State, Vec3 } from "../types";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Full-viewport absolutely-positioned SVG root (callers set pointer events). */
export function createFullscreenSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.style.position = "absolute";
  svg.style.inset    = "0";
  svg.style.width    = "100%";
  svg.style.height   = "100%";
  return svg;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Physical bounding box from `state.physical` (defaults to the [0,1]³ space). */
export function physicalBounds(state: State): { min: Vec3; max: Vec3 } {
  const spatial         = state.physical?.spatial;
  const size  : Vec3    = spatial?.size   ?? [1, 1, 1];
  const origin: Vec3    = spatial?.origin ?? [0, 0, 0];
  return {
    min: [origin[0], origin[1], origin[2]],
    max: [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]],
  };
}
