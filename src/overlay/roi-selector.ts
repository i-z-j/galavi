/**
 * RoiSelectorOverlay — 3D box region-of-interest overlay.
 *
 * One overlay with two presentations chosen by the bound view type:
 *
 * - Slice views (an AxisMap is present): interactive editor for the in-plane
 *   (u/v) extents of the box. Dragging on empty space creates a new box whose
 *   slice-axis extent spans the full physical range of that axis; dragging
 *   the body moves the box; dragging a corner handle resizes it. Edits only
 *   touch the two in-plane axes (the slice-axis extent is preserved) and are
 *   clamped to the physical bounding box. A range label with a
 *   copy-to-clipboard button is shown next to the rect.
 * - Volume / navigator views: read-only 12-edge wireframe of the box,
 *   projected with the perspective camera; edges with an endpoint behind
 *   the camera are skipped.
 *
 * The box itself is owned by the host app: it arrives via the `roi` option
 * and edits are reported through the `onRoiChange` callback (live during
 * drags and once more on pointerup). Accepted edits are also mirrored
 * internally so the overlay stays consistent when the app does not echo
 * the `roi` option back.
 *
 * Options:
 * - `roi`         — `{ min: Vec3; max: Vec3 } | null`, physical units.
 * - `enabled`     — slice-view editing (default true); false = display-only.
 * - `unit`        — label unit override (default `state.physical.spatial.unit`
 *                   or "µm").
 * - `onRoiChange` — `(roi: { min: Vec3; max: Vec3 }) => void`.
 */

import type { State, Vec3 } from "../types";
import {
  physicalToSliceScreen,
  physicalToVolumeScreen,
  screenToSlicePhysical,
  type AxisMap,
} from "../utils";
import { BaseOverlay } from "./base";

export type RoiBox = { min: Vec3; max: Vec3 };
export type RoiChangeCallback = (roi: RoiBox) => void;

type AxisSide = "min" | "max";

type DragState =
  | { kind: "create"; start: Vec3; previous: RoiBox | null }
  | { kind: "move"; start: Vec3; original: RoiBox }
  | { kind: "resize"; uSide: AxisSide; vSide: AxisSide; original: RoiBox };

interface RoiSelectorElements {
  svg         : SVGSVGElement;
  surface     : SVGRectElement;
  sliceLayer  : SVGGElement;
  body        : SVGRectElement;
  handles     : SVGRectElement[];
  volumeLayer : SVGGElement;
  edges       : SVGLineElement[];
  label       : HTMLDivElement;
  labelText   : HTMLSpanElement;
}

const SVG_NS      = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 10;

/** Logical box corners (u side, v side) edited by the four resize handles. */
const HANDLE_CORNERS: readonly { uSide: AxisSide; vSide: AxisSide }[] = [
  { uSide: "min", vSide: "min" },
  { uSide: "max", vSide: "min" },
  { uSide: "min", vSide: "max" },
  { uSide: "max", vSide: "max" },
];

/** Corner index pairs of the 12 box edges (volume wireframe). */
const EDGE_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
];

/** Copy-to-clipboard icon (lucide "copy"). */
const COPY_ICON_SVG =
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="9" y="9" width="13" height="13" rx="2"></rect>` +
  `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

// ============================================================================
// HELPERS
// ============================================================================

function isVec3(value: unknown): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/** Parse the untyped `roi` option: a normalized RoiBox, null, or undefined (leave unchanged). */
function parseRoi(value: unknown): RoiBox | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { min?: unknown; max?: unknown };
  if (!isVec3(candidate.min) || !isVec3(candidate.max)) return undefined;
  const min = [...candidate.min] as Vec3;
  const max = [...candidate.max] as Vec3;
  for (let axis = 0; axis < 3; axis++) {
    if (min[axis] > max[axis]) {
      const swap = min[axis];
      min[axis]  = max[axis];
      max[axis]  = swap;
    }
  }
  return { min, max };
}

function cloneRoi(roi: RoiBox): RoiBox {
  return { min: [...roi.min], max: [...roi.max] };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}

/** Physical bounding box from `state.physical` (defaults to the [0,1]³ space). */
function physicalBounds(state: State): RoiBox {
  const spatial         = state.physical?.spatial;
  const size  : Vec3    = spatial?.size   ?? [1, 1, 1];
  const origin: Vec3    = spatial?.origin ?? [0, 0, 0];
  return {
    min: [origin[0], origin[1], origin[2]],
    max: [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]],
  };
}

// ============================================================================
// ROI SELECTOR OVERLAY
// ============================================================================

export class RoiSelectorOverlay extends BaseOverlay {
  static readonly overlayType = "roiselector";

  private roi     : RoiBox | null = null;
  private enabled = true;
  private unit?   : string;

  private onRoiChange?: RoiChangeCallback;

  private drag   : DragState | null = null;
  private state? : State;
  private els?   : RoiSelectorElements;

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.inset    = "0";
    root.style.overflow = "hidden";
  }

  protected override onMount(root: HTMLDivElement, _parent: HTMLElement): void {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.style.position  = "absolute";
    svg.style.inset     = "0";
    svg.style.width     = "100%";
    svg.style.height    = "100%";
    svg.style.display   = "block";
    svg.style.overflow  = "hidden";
    root.appendChild(svg);

    // Full-viewport interaction surface (slice views only).
    const surface = document.createElementNS(SVG_NS, "rect");
    surface.setAttribute("x", "0");
    surface.setAttribute("y", "0");
    surface.setAttribute("width", "100%");
    surface.setAttribute("height", "100%");
    surface.style.fill          = "transparent";
    surface.style.cursor        = "crosshair";
    surface.style.pointerEvents = "none"; // toggled per frame in onRender
    surface.addEventListener("pointerdown", this.handleSurfacePointerDown);
    surface.addEventListener("mousedown", stopPropagation);
    svg.appendChild(surface);

    // Slice presentation: box rect + corner handles.
    const sliceLayer = document.createElementNS(SVG_NS, "g");
    sliceLayer.style.display = "none";
    svg.appendChild(sliceLayer);

    const body = document.createElementNS(SVG_NS, "rect");
    body.style.fill          = "var(--galavi-accent-soft)";
    body.style.stroke        = "var(--galavi-warn)";
    body.style.strokeWidth   = "1px";
    body.style.cursor        = "move";
    body.style.pointerEvents = "none"; // toggled per frame in onRender
    body.addEventListener("pointerdown", this.handleBodyPointerDown);
    body.addEventListener("mousedown", stopPropagation);
    sliceLayer.appendChild(body);

    const handles = HANDLE_CORNERS.map((corner) => {
      const handle = document.createElementNS(SVG_NS, "rect");
      handle.setAttribute("width", `${HANDLE_SIZE}`);
      handle.setAttribute("height", `${HANDLE_SIZE}`);
      handle.style.fill          = "var(--galavi-panel-bg)";
      handle.style.stroke        = "var(--galavi-warn)";
      handle.style.strokeWidth   = "1px";
      handle.style.cursor        = "crosshair";
      handle.style.pointerEvents = "auto";
      handle.addEventListener("pointerdown", (event) => this.startResize(corner, event));
      handle.addEventListener("mousedown", stopPropagation);
      sliceLayer.appendChild(handle);
      return handle;
    });

    // Volume presentation: 12-edge wireframe.
    const volumeLayer = document.createElementNS(SVG_NS, "g");
    volumeLayer.style.display = "none";
    svg.appendChild(volumeLayer);

    const edges = EDGE_PAIRS.map(() => {
      const edge = document.createElementNS(SVG_NS, "line");
      edge.style.stroke      = "var(--galavi-warn)";
      edge.style.strokeWidth = "1px";
      volumeLayer.appendChild(edge);
      return edge;
    });

    // Range label + copy button.
    const label = this.createLabel("tooltip");
    label.style.position      = "absolute";
    label.style.display       = "none";
    label.style.alignItems    = "center";
    label.style.gap           = "6px";
    label.style.pointerEvents = "none";

    const labelText = document.createElement("span");
    label.appendChild(labelText);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.title = "Copy physical range";
    copyButton.setAttribute("aria-label", "Copy physical range");
    copyButton.innerHTML             = COPY_ICON_SVG;
    copyButton.style.display         = "inline-flex";
    copyButton.style.alignItems      = "center";
    copyButton.style.justifyContent  = "center";
    copyButton.style.width           = "18px";
    copyButton.style.height          = "16px";
    copyButton.style.padding         = "0";
    copyButton.style.border          = "none";
    copyButton.style.background      = "transparent";
    copyButton.style.color           = "var(--galavi-text-dim)";
    copyButton.style.cursor          = "pointer";
    copyButton.style.pointerEvents   = "auto";
    copyButton.addEventListener("pointerdown", stopPropagation);
    copyButton.addEventListener("mousedown", stopPropagation);
    copyButton.addEventListener("click", () => { void this.copyRange(); });
    label.appendChild(copyButton);
    root.appendChild(label);

    this.els = { svg, surface, sliceLayer, body, handles, volumeLayer, edges, label, labelText };
  }

  protected override onUnmount(): void {
    this.removeDragListeners();
    this.drag   = null;
    this.state  = undefined;
    this.els    = undefined;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    const roi = parseRoi(opts.roi);
    if (roi !== undefined) this.roi = roi;
    if (typeof opts.enabled === "boolean") this.enabled = opts.enabled;
    if (typeof opts.unit === "string") this.unit = opts.unit;
    if (typeof opts.onRoiChange === "function") {
      this.onRoiChange = opts.onRoiChange as RoiChangeCallback;
    }
  }

  protected override onHidden(): void {
    this.cancelDrag();
  }

  // ==========================================================================
  // RENDER
  // ==========================================================================

  protected override onRender(state: State): void {
    this.state = state;

    const els    = this.els;
    const canvas = this.getCanvas();
    if (!els || !canvas) return;

    const width   = canvas.clientWidth;
    const height  = canvas.clientHeight;
    const axisMap = this.getAxisMap();

    if (axisMap) this.renderSlice(state, axisMap, width, height, els);
    else this.renderVolume(state, width, height, els);
  }

  /** Slice view: interactive editor of the box's in-plane (u/v) extents. */
  private renderSlice(
    state   : State,
    axisMap : AxisMap,
    width   : number,
    height  : number,
    els     : RoiSelectorElements,
  ): void {
    els.volumeLayer.style.display       = "none";
    els.surface.style.display           = "";
    els.surface.style.pointerEvents     = this.enabled ? "auto" : "none";

    const roi = this.roi;
    if (!roi || width <= 0 || height <= 0) {
      els.sliceLayer.style.display  = "none";
      els.label.style.display       = "none";
      return;
    }
    els.sliceLayer.style.display = "";

    const pMin = physicalToSliceScreen(roi.min, state, axisMap, width, height);
    const pMax = physicalToSliceScreen(roi.max, state, axisMap, width, height);
    const x = Math.min(pMin[0], pMax[0]);
    const y = Math.min(pMin[1], pMax[1]);
    const w = Math.max(1, Math.abs(pMax[0] - pMin[0]));
    const h = Math.max(1, Math.abs(pMax[1] - pMin[1]));

    els.body.setAttribute("x", `${x}`);
    els.body.setAttribute("y", `${y}`);
    els.body.setAttribute("width", `${w}`);
    els.body.setAttribute("height", `${h}`);
    els.body.style.pointerEvents  = this.enabled ? "auto" : "none";
    els.body.style.strokeDasharray = this.drag?.kind === "create" ? "4 3" : "none";

    HANDLE_CORNERS.forEach((corner, index) => {
      const handle = els.handles[index];
      handle.style.display = this.enabled ? "" : "none";
      const cx = corner.uSide === "min" ? pMin[0] : pMax[0];
      const cy = corner.vSide === "min" ? pMin[1] : pMax[1];
      handle.setAttribute("x", `${cx - HANDLE_SIZE / 2}`);
      handle.setAttribute("y", `${cy - HANDLE_SIZE / 2}`);
    });

    const unit = this.unit ?? state.physical?.spatial?.unit ?? "µm";
    els.labelText.textContent = this.rangeText(unit);
    els.label.style.display   = "flex";
    els.label.style.left      = `${Math.max(6, Math.min(width - 8, x))}px`;
    els.label.style.top       = `${Math.max(6, Math.min(height - 32, y + h + 7))}px`;
  }

  /** Volume / navigator view: read-only 12-edge wireframe of the box. */
  private renderVolume(
    state  : State,
    width  : number,
    height : number,
    els    : RoiSelectorElements,
  ): void {
    els.surface.style.display     = "none";
    els.sliceLayer.style.display  = "none";
    els.label.style.display       = "none";

    const roi = this.roi;
    if (!roi || width <= 0 || height <= 0) {
      els.volumeLayer.style.display = "none";
      return;
    }
    els.volumeLayer.style.display = "";

    const { min, max } = roi;
    const corners: Vec3[] = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]],
      [min[0], max[1], min[2]], [max[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]],
      [min[0], max[1], max[2]], [max[0], max[1], max[2]],
    ];
    const camera    = state.exploration.camera;
    const projected = corners.map((corner) => physicalToVolumeScreen(corner, camera, width, height));

    EDGE_PAIRS.forEach(([first, second], index) => {
      const edge  = els.edges[index];
      const start = projected[first];
      const end   = projected[second];
      if (start && end) {
        edge.setAttribute("x1", `${start[0]}`);
        edge.setAttribute("y1", `${start[1]}`);
        edge.setAttribute("x2", `${end[0]}`);
        edge.setAttribute("y2", `${end[1]}`);
        edge.style.display = "";
      } else {
        edge.style.display = "none";
      }
    });
  }

  // ==========================================================================
  // INTERACTION
  // ==========================================================================

  /** Unproject a pointer event to a physical position on the slice plane. */
  private pointFromEvent(event: PointerEvent): Vec3 | null {
    const state   = this.state;
    const axisMap = this.getAxisMap();
    const canvas  = this.getCanvas();
    const root    = this.root;
    if (!state || !axisMap || !canvas || !root) return null;

    const bounds = root.getBoundingClientRect();
    return screenToSlicePhysical(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      state,
      axisMap,
      canvas.clientWidth,
      canvas.clientHeight,
      state.exploration.camera.target[axisMap[2]],
    );
  }

  private readonly handleSurfacePointerDown = (event: PointerEvent): void => {
    event.stopPropagation();
    if (!this.enabled || event.button !== 0) return;
    const state   = this.state;
    const axisMap = this.getAxisMap();
    if (!state || !axisMap) return;
    const point = this.pointFromEvent(event);
    if (!point) return;

    // Seed a new box at the (clamped) pointer position; it spans the full
    // physical range of the slice axis.
    const bounds = physicalBounds(state);
    const u = axisMap[0];
    const v = axisMap[1];
    const s = axisMap[2];

    const start = [...point] as Vec3;
    start[u] = clamp(start[u], bounds.min[u], bounds.max[u]);
    start[v] = clamp(start[v], bounds.min[v], bounds.max[v]);

    this.drag = { kind: "create", start, previous: this.roi ? cloneRoi(this.roi) : null };

    const next: RoiBox = { min: [...start] as Vec3, max: [...start] as Vec3 };
    next.min[s] = bounds.min[s];
    next.max[s] = bounds.max[s];
    this.roi = next;

    this.addDragListeners();
    event.preventDefault();
  };

  private readonly handleBodyPointerDown = (event: PointerEvent): void => {
    event.stopPropagation();
    if (!this.enabled || event.button !== 0 || !this.roi) return;
    const point = this.pointFromEvent(event);
    if (!point) return;

    this.drag = { kind: "move", start: point, original: cloneRoi(this.roi) };
    this.addDragListeners();
    event.preventDefault();
  };

  private startResize(corner: { uSide: AxisSide; vSide: AxisSide }, event: PointerEvent): void {
    event.stopPropagation();
    if (!this.enabled || event.button !== 0 || !this.roi) return;

    this.drag = { kind: "resize", uSide: corner.uSide, vSide: corner.vSide, original: cloneRoi(this.roi) };
    this.addDragListeners();
    event.preventDefault();
  }

  private readonly handleWindowPointerMove = (event: PointerEvent): void => {
    const drag    = this.drag;
    const state   = this.state;
    const axisMap = this.getAxisMap();
    if (!drag || !state || !axisMap) return;
    const point = this.pointFromEvent(event);
    if (!point) return;

    const bounds = physicalBounds(state);
    const u = axisMap[0];
    const v = axisMap[1];
    const s = axisMap[2];

    if (drag.kind === "create") {
      const pu = clamp(point[u], bounds.min[u], bounds.max[u]);
      const pv = clamp(point[v], bounds.min[v], bounds.max[v]);
      const next: RoiBox = { min: [...drag.start] as Vec3, max: [...drag.start] as Vec3 };
      next.min[u] = Math.min(drag.start[u], pu);
      next.max[u] = Math.max(drag.start[u], pu);
      next.min[v] = Math.min(drag.start[v], pv);
      next.max[v] = Math.max(drag.start[v], pv);
      next.min[s] = bounds.min[s];
      next.max[s] = bounds.max[s];
      this.roi = next;
      this.emitRoiChange();
      return;
    }

    if (drag.kind === "move") {
      const next = cloneRoi(drag.original);
      for (const axis of [u, v]) {
        // Clamp the delta so the whole box stays inside the physical bounds.
        const lo    = bounds.min[axis] - drag.original.min[axis];
        const hi    = bounds.max[axis] - drag.original.max[axis];
        const delta = clamp(point[axis] - drag.start[axis], lo, hi);
        next.min[axis] = drag.original.min[axis] + delta;
        next.max[axis] = drag.original.max[axis] + delta;
      }
      this.roi = next;
      this.emitRoiChange();
      return;
    }

    // Resize: move the dragged edges; clamp to bounds and against the
    // opposite edge so the box can never invert.
    const next = cloneRoi(drag.original);
    const pu = clamp(point[u], bounds.min[u], bounds.max[u]);
    const pv = clamp(point[v], bounds.min[v], bounds.max[v]);
    if (drag.uSide === "min") next.min[u] = Math.min(pu, drag.original.max[u]);
    else next.max[u] = Math.max(pu, drag.original.min[u]);
    if (drag.vSide === "min") next.min[v] = Math.min(pv, drag.original.max[v]);
    else next.max[v] = Math.max(pv, drag.original.min[v]);
    this.roi = next;
    this.emitRoiChange();
  };

  private readonly handleWindowPointerUp = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.removeDragListeners();

    // A create drag with no in-plane extent is a plain click — restore the
    // previous box instead of keeping a degenerate one.
    const axisMap = this.getAxisMap();
    if (drag.kind === "create" && this.roi && axisMap) {
      const u = axisMap[0];
      const v = axisMap[1];
      if (this.roi.min[u] === this.roi.max[u] && this.roi.min[v] === this.roi.max[v]) {
        this.roi = drag.previous ? cloneRoi(drag.previous) : null;
        return;
      }
    }
    this.emitRoiChange();
  };

  private addDragListeners(): void {
    window.addEventListener("pointermove", this.handleWindowPointerMove);
    window.addEventListener("pointerup", this.handleWindowPointerUp);
    window.addEventListener("pointercancel", this.handleWindowPointerUp);
  }

  private removeDragListeners(): void {
    window.removeEventListener("pointermove", this.handleWindowPointerMove);
    window.removeEventListener("pointerup", this.handleWindowPointerUp);
    window.removeEventListener("pointercancel", this.handleWindowPointerUp);
  }

  /** Abort an in-progress drag without emitting (overlay hidden mid-drag). */
  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.removeDragListeners();
    if (drag.kind === "create") {
      this.roi = drag.previous ? cloneRoi(drag.previous) : null;
    }
  }

  // ==========================================================================
  // LABEL / CALLBACK
  // ==========================================================================

  private rangeText(unit: string): string {
    const roi = this.roi;
    if (!roi) return "";
    const format = (axis: number): string => `${roi.min[axis].toFixed(1)}-${roi.max[axis].toFixed(1)}`;
    return `X ${format(0)}  Y ${format(1)}  Z ${format(2)} ${unit}`;
  }

  private async copyRange(): Promise<void> {
    const unit = this.unit ?? this.state?.physical?.spatial?.unit ?? "µm";
    const text = this.rangeText(unit);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard unavailable (permissions or insecure context) — ignore.
    }
  }

  private emitRoiChange(): void {
    if (!this.onRoiChange || !this.roi) return;
    this.onRoiChange(cloneRoi(this.roi));
  }
}
