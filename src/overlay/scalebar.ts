/**
 * ScaleBarOverlay — DOM overlay showing physical scale.
 */

import type { State, Camera } from "../types";
import { cameraDistance } from "../utils";
import { DEFAULT_FOV } from "../defaults";
import { BaseOverlay, type OverlayCornerPosition } from "./base";

export class ScaleBarOverlay extends BaseOverlay {
  static readonly overlayType = "scalebar";
  private barEl?    : HTMLDivElement;
  private labelEl?  : HTMLDivElement;

  private opts = {
    position        : "top-right" as OverlayCornerPosition,
    maxWidthPercent : 20,
  };

  protected override onMount(root: HTMLDivElement): void {
    root.style.flexDirection  = "column";
    root.style.alignItems     = "flex-start";

    const label = this.createLabel("tooltip", "-");
    label.style.marginBottom  = "2px";
    label.style.padding       = "2px 6px";

    const bar = document.createElement("div");
    bar.style.background  = "#fff";
    bar.style.height      = "3px";
    bar.style.position    = "relative";
    bar.style.boxShadow   = "0 1px 3px rgba(0,0,0,0.3)";

    const createTick = (): HTMLDivElement => {
      const tick = document.createElement("div");
      tick.style.position   = "absolute";
      tick.style.width      = "1px";
      tick.style.height     = "8px";
      tick.style.background = "#fff";
      tick.style.top        = "-2px";
      tick.style.boxShadow  = "0 1px 3px rgba(0,0,0,0.3)";
      return tick;
    };

    const leftTick = createTick();
    leftTick.style.left = "0";
    bar.appendChild(leftTick);

    const rightTick = createTick();
    rightTick.style.right = "0";
    bar.appendChild(rightTick);

    root.appendChild(label);
    root.appendChild(bar);

    this.barEl    = bar;
    this.labelEl  = label;
    this.updatePosition();
  }

  protected override onUnmount(): void {
    this.barEl    = undefined;
    this.labelEl  = undefined;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    if (typeof opts.position === "string") {
      this.opts.position = opts.position as OverlayCornerPosition;
    }
    if (typeof opts.maxWidthPercent === "number") {
      this.opts.maxWidthPercent = opts.maxWidthPercent;
    }
    this.updatePosition();
  }

  protected override getDisplayMode(): string {
    return "flex";
  }

  protected override onRender(state: State): void {
    if (!this.labelEl || !this.barEl) return;

    const canvas          = this.getCanvas();
    const cam             = state.exploration.camera;
    const canvasWidth     = canvas?.clientWidth ?? 800;
    const canvasHeight    = canvas?.clientHeight ?? 600;
    const micronsPerPixel = this.computeMicronsPerPixel(cam, canvasHeight, this.getViewType() ?? "");

    const maxBarWidthPx     = Math.floor(canvasWidth * this.opts.maxWidthPercent / 100);
    const maxLengthMicrons  = maxBarWidthPx * micronsPerPixel;
    const niceLength        = this.getNiceScaleLength(maxLengthMicrons);
    const barWidthPx        = Math.max(10, Math.floor(niceLength / micronsPerPixel));

    const { value, unit }     = this.formatLength(niceLength, state.physical?.spatial?.unit);
    this.labelEl.textContent  = `${value} ${unit}`;
    this.barEl.style.width    = `${barWidthPx}px`;
  }

  private updatePosition(): void {
    this.positionRoot(this.opts.position, 12);
  }

  private computeMicronsPerPixel(
    cam           : Camera,
    canvasHeight  : number,
    viewType      : string,
  ): number {
    const is2D = viewType.includes("slice");
    const dist = cameraDistance(cam);

    if (is2D) {
      return dist / canvasHeight;
    }

    const visibleHeight = 2 * dist * Math.tan(DEFAULT_FOV / 2);
    return visibleHeight / canvasHeight;
  }

  private getNiceScaleLength(maxLength: number): number {
    if (maxLength <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(maxLength)));
    const niceFractions = [5, 2, 1];
    for (const fraction of niceFractions) {
      const candidate = magnitude * fraction;
      if (candidate <= maxLength) return candidate;
    }
    return magnitude / 2;
  }

  private formatLength(length: number, baseUnit?: string): { value: string; unit: string } {
    const unit = baseUnit ?? "μm";
    if ((unit === "μm" || unit === "µm" || unit === "um") && length >= 1000) {
      const mm = length / 1000;
      const decimals = mm < 1 ? 2 : mm < 10 ? 1 : 0;
      return { value: mm.toFixed(decimals), unit: "mm" };
    }
    const decimals = length >= 1 ? 0 : length >= 0.1 ? 1 : 2;
    return { value: length.toFixed(decimals), unit };
  }
}

export default ScaleBarOverlay;