/**
 * RoiSelectorOverlay — multiple 3D box region-of-interest overlay.
 *
 * One overlay with two presentations chosen by the bound view type:
 *
 * - Slice views (an AxisMap is present): interactive editor for the in-plane
 *   (u/v) extents of a box. Dragging on empty space adds a box whose
 *   slice-axis extent spans the full physical range of that axis; dragging
 *   the body moves the box; dragging a corner handle resizes it. Edits only
 *   touch the two in-plane axes (the slice-axis extent is preserved) and are
 *   clamped to the physical bounding box. A three-line range label with a
 *   copy-to-clipboard button is shown next to the rect.
 * - Volume / navigator views: read-only 12-edge wireframe of the box,
 *   projected with the perspective camera; edges with an endpoint behind
 *   the camera are skipped.
 *
 * The boxes are owned by the host app: they arrive via the `rois` option and
 * edits are reported through `onRoisChange` (live during drags and once more
 * on pointerup). Accepted edits are mirrored internally so the overlay stays
 * consistent when the app does not echo options back immediately.
 *
 * Options:
 * - `rois`                — `{ min: Vec3; max: Vec3 }[]`, physical units.
 * - `activeIndex`         — box currently exposing edit handles, or null.
 * - `enabled`             — slice editing (default true); false = display-only.
 * - `onRoisChange`        — receives the full array plus change metadata.
 * - `onActiveIndexChange` — receives the box activated by a body click.
 */

import type { State, Vec3 } from "../../state/schema";
import {
  physicalToSliceScreen,
  physicalToVolumeScreen,
  screenToSlicePhysical,
  type AxisMap,
} from "../../utils";
import { BaseOverlay } from "./base";
import { SVG_NS, clamp, createFullscreenSvg, physicalBounds } from "./utils";

export type RoiBox = { min: Vec3; max: Vec3 };
export type RoiChangeKind = "create" | "move" | "resize" | "remove";
export type RoiChangePhase = "live" | "commit";
export interface RoiSelectionChange {
  index : number;
  kind  : RoiChangeKind;
  phase : RoiChangePhase;
}
export type RoiSelectionsChangeCallback = (rois: RoiBox[], change: RoiSelectionChange) => void;
export type RoiActiveIndexChangeCallback = (activeIndex: number | null) => void;

type AxisSide = "min" | "max";

type DragState =
  | { kind: "create"; index: number; start: Vec3; previousActive: number | null }
  | { kind: "move"; index: number; start: Vec3; original: RoiBox }
  | { kind: "resize"; index: number; uSide: AxisSide; vSide: AxisSide; original: RoiBox };

interface RoiSelectionElements {
  sliceLayer  : SVGGElement;
  body        : SVGRectElement;
  handles     : SVGRectElement[];
  volumeLayer : SVGGElement;
  edges       : SVGLineElement[];
  label       : HTMLDivElement;
  labelText   : HTMLSpanElement;
  removeButton: HTMLButtonElement;
}

interface RoiSelectorElements {
  svg        : SVGSVGElement;
  surface    : SVGRectElement;
  selections: RoiSelectionElements[];
}

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

/** Parse an untyped box option into normalized physical ranges. */
function parseRoi(value: unknown): RoiBox | undefined {
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

function parseRois(value: unknown): RoiBox[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rois = value.map(parseRoi);
  return rois.every((roi): roi is RoiBox => Boolean(roi)) ? rois : undefined;
}

function cloneRoi(roi: RoiBox): RoiBox {
  return { min: [...roi.min], max: [...roi.max] };
}

function cloneRois(rois: readonly RoiBox[]): RoiBox[] {
  return rois.map(cloneRoi);
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}

// ============================================================================
// ROI SELECTOR OVERLAY
// ============================================================================

export class RoiSelectorOverlay extends BaseOverlay {
  static readonly overlayType = "roi-selector";

  private rois        : RoiBox[] = [];
  private activeIndex : number | null = null;
  private enabled     = true;

  private onRoisChange?       : RoiSelectionsChangeCallback;
  private onActiveIndexChange?: RoiActiveIndexChangeCallback;

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
    const svg = createFullscreenSvg();
    svg.style.display   = "block";
    svg.style.overflow  = "hidden";
    svg.addEventListener("wheel", this.handleWheel, { passive: false });
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

    this.els = { svg, surface, selections: [] };
  }

  private createSelectionElements(root: HTMLDivElement, svg: SVGSVGElement): RoiSelectionElements {
    const sliceLayer = document.createElementNS(SVG_NS, "g");
    sliceLayer.style.display = "none";
    svg.appendChild(sliceLayer);

    const body = document.createElementNS(SVG_NS, "rect");
    body.style.fill          = "var(--galavi-accent-soft)";
    body.style.stroke        = "var(--galavi-accent)";
    body.style.strokeWidth   = "1px";
    body.style.pointerEvents = "none";
    sliceLayer.appendChild(body);

    const handles = HANDLE_CORNERS.map(() => {
      const handle = document.createElementNS(SVG_NS, "rect");
      handle.setAttribute("width", `${HANDLE_SIZE}`);
      handle.setAttribute("height", `${HANDLE_SIZE}`);
      handle.style.fill          = "var(--galavi-panel-bg)";
      handle.style.stroke        = "var(--galavi-accent)";
      handle.style.strokeWidth   = "1px";
      handle.style.cursor        = "crosshair";
      handle.style.pointerEvents = "auto";
      sliceLayer.appendChild(handle);
      return handle;
    });

    const volumeLayer = document.createElementNS(SVG_NS, "g");
    volumeLayer.style.display = "none";
    svg.appendChild(volumeLayer);
    const edges = EDGE_PAIRS.map(() => {
      const edge = document.createElementNS(SVG_NS, "line");
      edge.style.stroke      = "var(--galavi-accent)";
      edge.style.strokeWidth = "1px";
      volumeLayer.appendChild(edge);
      return edge;
    });

    const label = this.createLabel("tooltip");
    label.style.position      = "absolute";
    label.style.display       = "none";
    label.style.alignItems    = "flex-start";
    label.style.gap           = "6px";
    label.style.pointerEvents = "none";
    const labelText = document.createElement("span");
    label.appendChild(labelText);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.title = "Copy physical range";
    copyButton.setAttribute("aria-label", "Copy physical range");
    copyButton.innerHTML            = COPY_ICON_SVG;
    copyButton.style.display        = "inline-flex";
    copyButton.style.alignItems     = "center";
    copyButton.style.justifyContent = "center";
    copyButton.style.width          = "18px";
    copyButton.style.height         = "16px";
    copyButton.style.padding        = "0";
    copyButton.style.border         = "none";
    copyButton.style.background     = "transparent";
    copyButton.style.color          = "var(--galavi-text-dim)";
    copyButton.style.cursor         = "pointer";
    copyButton.style.pointerEvents  = "auto";
    label.appendChild(copyButton);
    root.appendChild(label);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.title = "Remove selection";
    removeButton.setAttribute("aria-label", "Remove selection");
    removeButton.textContent            = "-";
    removeButton.style.position         = "absolute";
    removeButton.style.display          = "none";
    removeButton.style.width            = "18px";
    removeButton.style.height           = "18px";
    removeButton.style.padding          = "0";
    removeButton.style.border           = "1px solid var(--galavi-accent)";
    removeButton.style.borderRadius     = "2px";
    removeButton.style.background       = "var(--galavi-panel-bg)";
    removeButton.style.color            = "var(--galavi-accent)";
    removeButton.style.font             = "600 14px/1 var(--galavi-font-mono)";
    removeButton.style.cursor           = "pointer";
    removeButton.style.pointerEvents    = "auto";
    root.appendChild(removeButton);

    const selection = { sliceLayer, body, handles, volumeLayer, edges, label, labelText, removeButton };
    body.addEventListener("pointerdown", (event) => this.handleBodyPointerDown(selection, event));
    body.addEventListener("mousedown", stopPropagation);
    handles.forEach((handle, index) => {
      handle.addEventListener("pointerdown", (event) => this.startResize(selection, HANDLE_CORNERS[index], event));
      handle.addEventListener("mousedown", stopPropagation);
    });
    copyButton.addEventListener("pointerdown", stopPropagation);
    copyButton.addEventListener("mousedown", stopPropagation);
    copyButton.addEventListener("click", () => { void this.copyRange(selection); });
    removeButton.addEventListener("pointerdown", stopPropagation);
    removeButton.addEventListener("mousedown", stopPropagation);
    removeButton.addEventListener("click", (event) => this.removeSelection(selection, event));
    return selection;
  }

  private ensureSelectionElements(count: number): void {
    const els = this.els;
    const root = this.root;
    if (!els || !root) return;
    while (els.selections.length < count) {
      els.selections.push(this.createSelectionElements(root, els.svg));
    }
    while (els.selections.length > count) {
      const selection = els.selections.pop();
      selection?.sliceLayer.remove();
      selection?.volumeLayer.remove();
      selection?.label.remove();
      selection?.removeButton.remove();
    }
  }

  protected override onUnmount(): void {
    this.removeDragListeners();
    this.drag   = null;
    this.state  = undefined;
    this.els    = undefined;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    const rois = parseRois(opts.rois);
    if (rois) this.rois = rois;
    if (opts.activeIndex === null) this.activeIndex = null;
    if (typeof opts.activeIndex === "number") {
      const index = Math.floor(opts.activeIndex);
      this.activeIndex = index >= 0 && index < this.rois.length ? index : null;
    }
    if (this.activeIndex !== null && this.activeIndex >= this.rois.length) this.activeIndex = null;
    if (typeof opts.enabled === "boolean") this.enabled = opts.enabled;
    if (typeof opts.onRoisChange === "function") {
      this.onRoisChange = opts.onRoisChange as RoiSelectionsChangeCallback;
    }
    if (typeof opts.onActiveIndexChange === "function") {
      this.onActiveIndexChange = opts.onActiveIndexChange as RoiActiveIndexChangeCallback;
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
    this.ensureSelectionElements(this.rois.length);
    els.surface.style.display       = "";
    els.surface.style.pointerEvents = this.enabled ? "auto" : "none";

    els.selections.forEach((selection, index) => {
      selection.volumeLayer.style.display = "none";
      const roi = this.rois[index];
      if (!roi || width <= 0 || height <= 0) {
        selection.sliceLayer.style.display   = "none";
        selection.label.style.display        = "none";
        selection.removeButton.style.display = "none";
        return;
      }

      selection.sliceLayer.style.display = "";
      const pMin = physicalToSliceScreen(roi.min, state, axisMap, width, height);
      const pMax = physicalToSliceScreen(roi.max, state, axisMap, width, height);
      const x = Math.min(pMin[0], pMax[0]);
      const y = Math.min(pMin[1], pMax[1]);
      const w = Math.max(1, Math.abs(pMax[0] - pMin[0]));
      const h = Math.max(1, Math.abs(pMax[1] - pMin[1]));
      const active = index === this.activeIndex;

      selection.body.setAttribute("x", `${x}`);
      selection.body.setAttribute("y", `${y}`);
      selection.body.setAttribute("width", `${w}`);
      selection.body.setAttribute("height", `${h}`);
      selection.body.style.cursor          = active ? "move" : "pointer";
      selection.body.style.pointerEvents   = this.enabled ? "auto" : "none";
      selection.body.style.strokeWidth     = active ? "1.5px" : "1px";
      selection.body.style.strokeDasharray = this.drag?.kind === "create" && this.drag.index === index ? "4 3" : "none";

      HANDLE_CORNERS.forEach((corner, cornerIndex) => {
        const handle = selection.handles[cornerIndex];
        handle.style.display = this.enabled && active ? "" : "none";
        const cx = corner.uSide === "min" ? pMin[0] : pMax[0];
        const cy = corner.vSide === "min" ? pMin[1] : pMax[1];
        handle.setAttribute("x", `${cx - HANDLE_SIZE / 2}`);
        handle.setAttribute("y", `${cy - HANDLE_SIZE / 2}`);
      });

      selection.labelText.textContent = this.rangeText(index);
      selection.label.style.display   = "flex";
      selection.label.style.left      = `${Math.max(6, Math.min(width - 8, x))}px`;
      selection.label.style.top       = `${Math.max(6, Math.min(height - 58, y + h + 7))}px`;

      selection.removeButton.style.display = this.enabled ? "block" : "none";
      selection.removeButton.style.left    = `${Math.max(18, Math.min(width - 4, x + w))}px`;
      selection.removeButton.style.top     = `${Math.max(4, Math.min(height - 22, y + 4))}px`;
      selection.removeButton.style.transform = "translateX(-100%)";
    });
  }

  /** Volume / navigator view: read-only 12-edge wireframe of the box. */
  private renderVolume(
    state  : State,
    width  : number,
    height : number,
    els    : RoiSelectorElements,
  ): void {
    els.surface.style.display     = "none";
    this.ensureSelectionElements(this.rois.length);

    els.selections.forEach((selection, selectionIndex) => {
      selection.sliceLayer.style.display   = "none";
      selection.label.style.display        = "none";
      selection.removeButton.style.display = "none";
      const roi = this.rois[selectionIndex];
      if (!roi || width <= 0 || height <= 0) {
        selection.volumeLayer.style.display = "none";
        return;
      }
      selection.volumeLayer.style.display = "";

      const { min, max } = roi;
      const corners: Vec3[] = [
        [min[0], min[1], min[2]], [max[0], min[1], min[2]],
        [min[0], max[1], min[2]], [max[0], max[1], min[2]],
        [min[0], min[1], max[2]], [max[0], min[1], max[2]],
        [min[0], max[1], max[2]], [max[0], max[1], max[2]],
      ];
      const camera    = state.exploration.camera;
      const projected = corners.map((corner) => {
        const viewProjection = this.projectPhysicalToScreen(corner);
        return viewProjection === undefined
          ? physicalToVolumeScreen(corner, camera, width, height)
          : viewProjection;
      });

      EDGE_PAIRS.forEach(([first, second], edgeIndex) => {
        const edge  = selection.edges[edgeIndex];
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
    });
  }

  // ==========================================================================
  // INTERACTION
  // ==========================================================================

  /** Keep canvas-owned wheel zoom working while the selector SVG is on top. */
  private readonly handleWheel = (event: WheelEvent): void => {
    const canvas = this.getCanvas();
    if (!canvas) return;

    event.stopPropagation();
    const forwarded = new WheelEvent(event.type, {
      bubbles    : true,
      cancelable : true,
      composed   : true,
      clientX    : event.clientX,
      clientY    : event.clientY,
      ctrlKey    : event.ctrlKey,
      shiftKey   : event.shiftKey,
      altKey     : event.altKey,
      metaKey    : event.metaKey,
      deltaX     : event.deltaX,
      deltaY     : event.deltaY,
      deltaZ     : event.deltaZ,
      deltaMode  : event.deltaMode,
    });
    canvas.dispatchEvent(forwarded);
    if (forwarded.defaultPrevented) event.preventDefault();
  };

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

    const next: RoiBox = { min: [...start] as Vec3, max: [...start] as Vec3 };
    next.min[s] = bounds.min[s];
    next.max[s] = bounds.max[s];
    const previousActive = this.activeIndex;
    const index = this.rois.length;
    this.rois = [...this.rois, next];
    this.drag = { kind: "create", index, start, previousActive };
    this.emitRoisChange(index, "create", "live");
    this.setActiveIndex(index, true);

    this.addDragListeners();
    this.getOwner()?.requestRender();
    event.preventDefault();
  };

  private handleBodyPointerDown(selection: RoiSelectionElements, event: PointerEvent): void {
    event.stopPropagation();
    if (!this.enabled || event.button !== 0) return;
    const index = this.els?.selections.indexOf(selection) ?? -1;
    const roi = this.rois[index];
    if (index < 0 || !roi) return;
    if (index !== this.activeIndex) {
      this.setActiveIndex(index, true);
      this.getOwner()?.requestRender();
      event.preventDefault();
      return;
    }
    const point = this.pointFromEvent(event);
    if (!point) return;

    this.drag = { kind: "move", index, start: point, original: cloneRoi(roi) };
    this.addDragListeners();
    event.preventDefault();
  }

  private startResize(
    selection : RoiSelectionElements,
    corner    : { uSide: AxisSide; vSide: AxisSide },
    event     : PointerEvent,
  ): void {
    event.stopPropagation();
    if (!this.enabled || event.button !== 0) return;
    const index = this.els?.selections.indexOf(selection) ?? -1;
    const roi = this.rois[index];
    if (index < 0 || index !== this.activeIndex || !roi) return;

    this.drag = { kind: "resize", index, uSide: corner.uSide, vSide: corner.vSide, original: cloneRoi(roi) };
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
      this.replaceRoi(drag.index, next);
      this.emitRoisChange(drag.index, "create", "live");
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
      this.replaceRoi(drag.index, next);
      this.emitRoisChange(drag.index, "move", "live");
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
    this.replaceRoi(drag.index, next);
    this.emitRoisChange(drag.index, "resize", "live");
  };

  private readonly handleWindowPointerUp = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.removeDragListeners();

    // A create drag with no in-plane extent is a plain click — restore the
    // previous box instead of keeping a degenerate one.
    const axisMap = this.getAxisMap();
    const roi = this.rois[drag.index];
    if (drag.kind === "create" && roi && axisMap) {
      const u = axisMap[0];
      const v = axisMap[1];
      if (roi.min[u] === roi.max[u] && roi.min[v] === roi.max[v]) {
        this.rois = this.rois.filter((_, index) => index !== drag.index);
        this.setActiveIndex(drag.previousActive, true);
        this.emitRoisChange(drag.index, "create", "commit");
        this.getOwner()?.requestRender();
        return;
      }
    }
    this.emitRoisChange(drag.index, drag.kind, "commit");
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
      this.rois = this.rois.filter((_, index) => index !== drag.index);
      this.setActiveIndex(drag.previousActive, false);
    }
  }

  // ==========================================================================
  // LABEL / CALLBACK
  // ==========================================================================

  private rangeText(index: number): string {
    const roi = this.rois[index];
    if (!roi) return "";
    const format = (axis: number): string => `${roi.min[axis].toFixed(1)} - ${roi.max[axis].toFixed(1)}`;
    return `X ${format(0)}\nY ${format(1)}\nZ ${format(2)}`;
  }

  private async copyRange(selection: RoiSelectionElements): Promise<void> {
    const index = this.els?.selections.indexOf(selection) ?? -1;
    const text = this.rangeText(index);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard unavailable (permissions or insecure context) — ignore.
    }
  }

  private removeSelection(selection: RoiSelectionElements, event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    const index = this.els?.selections.indexOf(selection) ?? -1;
    if (index < 0 || index >= this.rois.length) return;
    this.rois = this.rois.filter((_, selectionIndex) => selectionIndex !== index);
    const nextActive = this.activeIndex === index
      ? null
      : this.activeIndex !== null && this.activeIndex > index
        ? this.activeIndex - 1
        : this.activeIndex;
    this.setActiveIndex(nextActive, true);
    this.emitRoisChange(index, "remove", "commit");
    this.getOwner()?.requestRender();
  }

  private replaceRoi(index: number, roi: RoiBox): void {
    this.rois = this.rois.map((current, selectionIndex) => selectionIndex === index ? roi : current);
    this.getOwner()?.requestRender();
  }

  private setActiveIndex(index: number | null, emit: boolean): void {
    const next = index !== null && index >= 0 && index < this.rois.length ? index : null;
    if (next === this.activeIndex) return;
    this.activeIndex = next;
    if (emit) this.onActiveIndexChange?.(next);
  }

  private emitRoisChange(index: number, kind: RoiChangeKind, phase: RoiChangePhase): void {
    this.onRoisChange?.(cloneRois(this.rois), { index, kind, phase });
  }
}
