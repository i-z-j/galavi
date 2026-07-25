/**
 * RulerOverlay — draggable two-endpoint measurement line.
 *
 * Port of the cerevi-web `RulerOverlay.vue` component to the BaseOverlay
 * architecture: an SVG line with draggable bar handles at both endpoints,
 * a thick invisible hit-target for whole-line drags, and a distance label at
 * the line midpoint. `unitsPerPixel` is derived from the live galavi `State`
 * each frame (slice views → orthographic scale, volume views → perspective
 * scale at the target plane) instead of arriving as a prop.
 */

import type { State } from "../types";
import { sliceUnitsPerPixel, volumeUnitsPerPixel } from "../utils";
import { BaseOverlay } from "./base";

const SVG_NS = "http://www.w3.org/2000/svg";

type DragTarget = "start" | "end" | "line";

type Point = { x: number; y: number };

export class RulerOverlay extends BaseOverlay {
  static readonly overlayType = "ruler";

  private hitLineEl? : SVGLineElement;
  private lineEl?    : SVGLineElement;
  private startHitEl?: SVGCircleElement;
  private startEl?   : SVGLineElement;
  private endHitEl?  : SVGCircleElement;
  private endEl?     : SVGLineElement;
  private labelEl?   : HTMLDivElement;

  private start : Point = { x: 0, y: 0 };
  private end   : Point = { x: 0, y: 0 };

  private drag           : DragTarget | null = null;
  private lastPointer    : Point             = { x: 0, y: 0 };
  private lastResetNonce?: number;

  private opts = {
    unit      : undefined as string | undefined,
    lineWidth : 1,
  };

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;

    const deltaX = event.clientX - this.lastPointer.x;
    const deltaY = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };

    if (this.drag === "start" || this.drag === "line") {
      this.start.x += deltaX;
      this.start.y += deltaY;
    }
    if (this.drag === "end" || this.drag === "line") {
      this.end.x += deltaX;
      this.end.y += deltaY;
    }
  };

  private readonly handlePointerUp = (): void => {
    this.drag = null;
  };

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.inset    = "0";
    root.style.overflow = "hidden";
  }

  protected override onMount(root: HTMLDivElement): void {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.style.position = "absolute";
    svg.style.inset    = "0";
    svg.style.width    = "100%";
    svg.style.height   = "100%";

    // Whole-line hit target — thicker than the visible line.
    const hitLine = document.createElementNS(SVG_NS, "line");
    hitLine.style.stroke        = "transparent";
    hitLine.style.pointerEvents = "stroke";
    hitLine.style.cursor        = "move";
    hitLine.addEventListener("pointerdown", (event) => this.beginDrag("line", event as PointerEvent));

    const line = document.createElementNS(SVG_NS, "line");
    line.style.stroke         = "var(--galavi-accent)";
    line.style.strokeLinecap  = "round";

    const buildHandle = (cursor: string): { group: SVGGElement; hit: SVGCircleElement; bar: SVGLineElement } => {
      const group = document.createElementNS(SVG_NS, "g");
      group.style.pointerEvents = "all";
      group.style.cursor        = cursor;

      const hit = document.createElementNS(SVG_NS, "circle");
      hit.setAttribute("r", "9");
      hit.style.fill = "transparent";

      const bar = document.createElementNS(SVG_NS, "line");
      bar.style.stroke        = "var(--galavi-accent)";
      bar.style.strokeLinecap = "square";

      group.appendChild(hit);
      group.appendChild(bar);
      return { group, hit, bar };
    };

    const startHandle = buildHandle("grab");
    startHandle.group.addEventListener("pointerdown", (event) => this.beginDrag("start", event as PointerEvent));
    const endHandle   = buildHandle("grab");
    endHandle.group.addEventListener("pointerdown", (event) => this.beginDrag("end", event as PointerEvent));

    svg.appendChild(hitLine);
    svg.appendChild(line);
    svg.appendChild(startHandle.group);
    svg.appendChild(endHandle.group);
    root.appendChild(svg);

    const label = this.createLabel("tooltip", "-");
    label.style.position  = "absolute";
    label.style.transform = "translate(-50%, -150%)";
    root.appendChild(label);

    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);

    this.hitLineEl  = hitLine;
    this.lineEl     = line;
    this.startHitEl = startHandle.hit;
    this.startEl    = startHandle.bar;
    this.endHitEl   = endHandle.hit;
    this.endEl      = endHandle.bar;
    this.labelEl    = label;

    this.applyStyles();
    this.reset();
  }

  protected override onUnmount(): void {
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);

    this.hitLineEl  = undefined;
    this.lineEl     = undefined;
    this.startHitEl = undefined;
    this.startEl    = undefined;
    this.endHitEl   = undefined;
    this.endEl      = undefined;
    this.labelEl    = undefined;
    this.drag       = null;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    if (typeof opts.unit === "string") this.opts.unit = opts.unit;
    if (typeof opts.lineWidth === "number") this.opts.lineWidth = opts.lineWidth;

    if (typeof opts.resetNonce === "number" && opts.resetNonce !== this.lastResetNonce) {
      this.lastResetNonce = opts.resetNonce;
      this.reset();
    }

    this.applyStyles();
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  protected override onRender(state: State): void {
    if (!this.lineEl || !this.hitLineEl || !this.labelEl) return;
    if (!this.startEl || !this.startHitEl || !this.endEl || !this.endHitEl) return;

    this.lineEl.setAttribute("x1", String(this.start.x));
    this.lineEl.setAttribute("y1", String(this.start.y));
    this.lineEl.setAttribute("x2", String(this.end.x));
    this.lineEl.setAttribute("y2", String(this.end.y));

    this.hitLineEl.setAttribute("x1", String(this.start.x));
    this.hitLineEl.setAttribute("y1", String(this.start.y));
    this.hitLineEl.setAttribute("x2", String(this.end.x));
    this.hitLineEl.setAttribute("y2", String(this.end.y));

    this.startHitEl.setAttribute("cx", String(this.start.x));
    this.startHitEl.setAttribute("cy", String(this.start.y));
    this.endHitEl.setAttribute("cx", String(this.end.x));
    this.endHitEl.setAttribute("cy", String(this.end.y));

    const lineLength = Math.max(1, Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y));
    const capOffsetX = (this.start.y - this.end.y) / lineLength * 6;
    const capOffsetY = (this.end.x - this.start.x) / lineLength * 6;
    this.positionCap(this.startEl, this.start, capOffsetX, capOffsetY);
    this.positionCap(this.endEl, this.end, capOffsetX, capOffsetY);

    const unit           = this.opts.unit ?? state.physical?.spatial?.unit ?? "µm";
    const unitsPerPixel  = this.computeUnitsPerPixel(state);
    this.labelEl.textContent = this.formatDistance(unitsPerPixel, unit);
    this.labelEl.style.left  = `${(this.start.x + this.end.x) / 2}px`;
    this.labelEl.style.top   = `${(this.start.y + this.end.y) / 2}px`;
  }

  // ============================================================================
  // INTERACTION
  // ============================================================================

  private beginDrag(target: DragTarget, event: PointerEvent): void {
    this.drag        = target;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    event.stopPropagation();
    event.preventDefault();
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /** Default horizontal segment centered in the viewport's upper-right area. */
  private reset(): void {
    const canvas  = this.getCanvas();
    const width   = canvas?.clientWidth ?? this.getHostElement()?.clientWidth ?? 0;
    const height  = canvas?.clientHeight ?? this.getHostElement()?.clientHeight ?? 0;
    const centerX = width * 0.7;
    const centerY = height * 0.125;
    const length  = Math.min(200, Math.max(60, width * 0.25));
    this.start.x  = Math.max(12, centerX - length / 2);
    this.start.y  = Math.max(12, centerY);
    this.end.x    = Math.min(width - 12, centerX + length / 2);
    this.end.y    = Math.max(12, centerY);
  }

  private positionCap(element: SVGLineElement, point: Point, offsetX: number, offsetY: number): void {
    element.setAttribute("x1", String(point.x - offsetX));
    element.setAttribute("y1", String(point.y - offsetY));
    element.setAttribute("x2", String(point.x + offsetX));
    element.setAttribute("y2", String(point.y + offsetY));
  }

  private computeUnitsPerPixel(state: State): number | undefined {
    const canvas = this.getCanvas();
    if (!canvas || canvas.clientHeight <= 0) return undefined;

    const viewType = this.getViewType() ?? "";
    if (viewType === "slice")  return sliceUnitsPerPixel(state, canvas.clientHeight);
    if (viewType === "volume") return volumeUnitsPerPixel(state.exploration.camera, canvas.clientHeight);
    return undefined;
  }

  /** Cerevi `distanceLabel` formatting, including µm→mm promotion at ≥1000. */
  private formatDistance(unitsPerPixel: number | undefined, unit: string): string {
    if (unitsPerPixel === undefined) return "-";
    const distance = Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y) * unitsPerPixel;
    if (!Number.isFinite(distance) || distance <= 0) return "-";
    if (["μm", "µm", "um"].includes(unit) && distance >= 1000) return `${(distance / 1000).toFixed(2)} mm`;
    return `${distance.toFixed(distance >= 100 ? 0 : distance >= 1 ? 1 : 2)} ${unit || "μm"}`;
  }

  private applyStyles(): void {
    if (!this.lineEl || !this.hitLineEl) return;
    this.lineEl.style.strokeWidth    = String(this.opts.lineWidth);
    this.hitLineEl.style.strokeWidth = String(Math.max(12, this.opts.lineWidth + 8));
    const capWidth = String(Math.max(2, this.opts.lineWidth));
    if (this.startEl) this.startEl.style.strokeWidth = capWidth;
    if (this.endEl) this.endEl.style.strokeWidth = capWidth;
  }
}

export default RulerOverlay;
