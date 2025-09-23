/**
 * MarkerOverlay — DOM marker for the current camera target.
 */

import type { State, Vec3 } from "../types";
import { cameraDistance, type AxisMap } from "../utils";
import { BaseOverlay, type OverlayCornerPosition } from "./base";

type MarkerShape  = "dot" | "cross" | "triangle" | "none";

export class MarkerOverlay extends BaseOverlay {
  static readonly overlayType = "marker";
  private shapeEl?  : HTMLDivElement;
  private textEl?   : HTMLDivElement;
  private isHovered = false;
  private screenPos : [number, number] | null = null;

  private opts = {
    shape         : "none" as MarkerShape,
    shapeColor    : "rgba(220, 50, 50, 0.85)",
    shapeSize     : 8,
    textPosition  : "top-right" as OverlayCornerPosition,
    precision     : 1,
    axisMap       : undefined as AxisMap | undefined,
  };

  private readonly handlePointerMove = (event: MouseEvent): void => {
    const hostEl = this.getHostElement();
    if (!hostEl || !this.screenPos || this.opts.shape === "none") {
      this.isHovered = false;
      this.syncHoverText();
      return;
    }

    const bounds    = hostEl.getBoundingClientRect();
    const pointerX  = event.clientX - bounds.left;
    const pointerY  = event.clientY - bounds.top;
    const dx        = pointerX - this.screenPos[0];
    const dy        = pointerY - this.screenPos[1];
    const radius    = Math.max(this.opts.shapeSize * 1.5, 14);

    this.isHovered = (dx * dx + dy * dy) <= radius * radius;
    this.syncHoverText();
  };

  private readonly handlePointerLeave = (): void => {
    this.isHovered = false;
    this.syncHoverText();
  };

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.inset    = "0";
    root.style.overflow = "hidden";
  }

  protected override onMount(root: HTMLDivElement, parent: HTMLElement): void {
    const shape = document.createElement("div");
    shape.style.position  = "absolute";
    shape.style.display   = "none";
    root.appendChild(shape);

    const text = this.createLabel("tooltip");
    text.style.position = "absolute";
    root.appendChild(text);

    parent.addEventListener("mousemove", this.handlePointerMove);
    parent.addEventListener("mouseleave", this.handlePointerLeave);

    this.shapeEl = shape;
    this.textEl  = text;
    this.applyStyles();
  }

  protected override onUnmount(): void {
    const hostEl = this.getHostElement();
    if (hostEl) {
      hostEl.removeEventListener("mousemove", this.handlePointerMove);
      hostEl.removeEventListener("mouseleave", this.handlePointerLeave);
    }
    this.shapeEl    = undefined;
    this.textEl     = undefined;
    this.isHovered  = false;
    this.screenPos  = null;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    if (typeof opts.shape === "string") this.opts.shape = opts.shape as MarkerShape;
    if (typeof opts.shapeColor === "string") this.opts.shapeColor = opts.shapeColor;
    if (typeof opts.shapeSize === "number") this.opts.shapeSize = opts.shapeSize;
    if (typeof opts.textPosition === "string") this.opts.textPosition = opts.textPosition as OverlayCornerPosition;
    if (typeof opts.precision === "number") this.opts.precision = opts.precision;
    if (Array.isArray(opts.axisMap)) this.opts.axisMap = opts.axisMap as AxisMap;

    this.applyStyles();
  }

  protected override onHidden(): void {
    this.isHovered  = false;
    this.screenPos  = null;
    if (this.shapeEl) this.shapeEl.style.display = "none";
    this.syncHoverText();
  }

  protected override onRender(state: State): void {
    if (!this.root || !this.textEl || !this.shapeEl) return;

    const canvas  = this.getCanvas();

    const target  = state.exploration.camera.target;
    const p       = this.opts.precision;

    this.textEl.textContent   = `X: ${target[0].toFixed(p)}  Y: ${target[1].toFixed(p)}  Z: ${target[2].toFixed(p)}`;
    this.textEl.style.display = "none";

    const am = this.opts.axisMap;
    if (canvas && this.opts.shape !== "none") {
      const screenPos = am
        ? this.projectToScreen(target, state, am, canvas)
        : [canvas.clientWidth / 2, canvas.clientHeight / 2] as [number, number];

      if (screenPos) {
        this.screenPos = screenPos;
        const halfSize = this.opts.shapeSize / 2;
        this.shapeEl.style.left    = `${screenPos[0] - halfSize}px`;
        this.shapeEl.style.top     = `${screenPos[1] - halfSize}px`;
        this.shapeEl.style.display = "block";
        this.syncHoverText();
      } else {
        this.shapeEl.style.display = "none";
        this.isHovered  = false;
        this.screenPos  = null;
        this.syncHoverText();
      }
    } else {
      this.shapeEl.style.display = "none";
      this.isHovered  = false;
      this.screenPos  = null;
      this.syncHoverText();
    }
  }

  private projectToScreen(
    target  : Vec3,
    state   : State,
    am      : [number, number, number],
    canvas  : HTMLCanvasElement,
  ): [number, number] | null {
    const cam             = state.exploration.camera;
    const sceneSize       = (state.physical?.spatial?.size ?? [1, 1, 1]) as Vec3;
    const sliceExtent     = Math.max(sceneSize[am[0]], sceneSize[am[1]], 1e-6);
    const dist            = cameraDistance(cam);
    const effectiveScale  = sliceExtent / dist;
    const halfExtent      = sliceExtent / (2 * effectiveScale);

    const center2D = [cam.target[am[0]], cam.target[am[1]]];
    const target2D = [target[am[0]], target[am[1]]];

    const aspect  = canvas.clientWidth / canvas.clientHeight;
    const clipX   = (target2D[0] - center2D[0]) / (halfExtent * aspect);
    const clipY   = -(target2D[1] - center2D[1]) / halfExtent;

    const px = (clipX * 0.5 + 0.5) * canvas.clientWidth;
    const py = (clipY * 0.5 + 0.5) * canvas.clientHeight;

    if (px < -20 || px > canvas.clientWidth + 20 || py < -20 || py > canvas.clientHeight + 20) {
      return null;
    }
    return [px, py];
  }

  private syncHoverText(): void {
    if (!this.textEl) return;

    const canvas = this.getCanvas();
    if (this.isHovered && this.screenPos && canvas && this.opts.shape !== "none") {
      this.positionTextAtMarker(this.screenPos, canvas);
      this.textEl.style.display = "block";
      return;
    }

    this.textEl.style.display = "none";
  }

  private applyStyles(): void {
    if (!this.shapeEl || !this.textEl) return;

    this.applyLabelStyle(this.textEl, "tooltip");

    const s = this.opts.shapeSize;

    switch (this.opts.shape) {
      case "dot":
        this.shapeEl.style.width        = `${s}px`;
        this.shapeEl.style.height       = `${s}px`;
        this.shapeEl.style.borderRadius = "50%";
        this.shapeEl.style.background   = this.opts.shapeColor;
        this.shapeEl.style.border       = "1px solid rgba(255,255,255,0.6)";
        this.shapeEl.innerHTML          = "";
        break;
      case "cross": {
        this.shapeEl.style.width        = `${s}px`;
        this.shapeEl.style.height       = `${s}px`;
        this.shapeEl.style.borderRadius = "0";
        this.shapeEl.style.background   = "transparent";
        this.shapeEl.style.border       = "none";
        const c = this.opts.shapeColor;
        this.shapeEl.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><line x1="0" y1="${s/2}" x2="${s}" y2="${s/2}" stroke="${c}" stroke-width="1.5"/><line x1="${s/2}" y1="0" x2="${s/2}" y2="${s}" stroke="${c}" stroke-width="1.5"/></svg>`;
        break;
      }
      case "triangle": {
        this.shapeEl.style.width        = `${s}px`;
        this.shapeEl.style.height       = `${s}px`;
        this.shapeEl.style.borderRadius = "0";
        this.shapeEl.style.background   = "transparent";
        this.shapeEl.style.border       = "none";
        const c = this.opts.shapeColor;
        const h = s * 0.866;
        this.shapeEl.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><polygon points="${s/2},0 ${s},${h} 0,${h}" fill="${c}" opacity="0.8"/></svg>`;
        break;
      }
      default:
        this.shapeEl.style.display = "none";
        break;
    }

    this.textEl.style.display = "none";
  }

  private positionTextAtMarker(
    screenPos : [number, number],
    canvas    : HTMLCanvasElement,
  ): void {
    if (!this.textEl) return;

    const [px, py]  = screenPos;
    const halfSize  = this.opts.shapeSize / 2;
    const gap       = 6;
    const margin    = 8;

    const { width, height } = this.measureElement(this.textEl);

    let left  = px;
    let top   = py;

    switch (this.opts.textPosition) {
      case "top-left":
        left  = px - halfSize - gap - width;
        top   = py - halfSize - gap - height;
        break;
      case "top-right":
        left  = px + halfSize + gap;
        top   = py - halfSize - gap - height;
        break;
      case "bottom-left":
        left  = px - halfSize - gap - width;
        top   = py + halfSize + gap;
        break;
      case "bottom-right":
        left  = px + halfSize + gap;
        top   = py + halfSize + gap;
        break;
    }

    [left, top] = this.clampToCanvas(left, top, width, height, canvas, margin);

    this.textEl.style.left    = "";
    this.textEl.style.right   = "";
    this.textEl.style.top     = "";
    this.textEl.style.bottom  = "";
    this.textEl.style.left    = `${left}px`;
    this.textEl.style.top     = `${top}px`;
  }
}