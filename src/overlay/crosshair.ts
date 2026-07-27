/**
 * CrosshairOverlay — axis lines through a target point.
 *
 * Slice views show a full-viewport cross through the projection of the
 * `position` option (defaults to the camera target); both lines hide when
 * the point leaves the viewport. Volume/navigator views show a 3-axis
 * reticle through the camera target, each line spanning the data bounding
 * box along its axis. Display-only — no pointer interaction.
 */

import type { State, Vec3 } from "../types";
import { physicalToSliceScreen, physicalToVolumeScreen, type AxisMap } from "../utils";
import { BaseOverlay } from "./base";
import { SVG_NS, createFullscreenSvg, physicalBounds } from "./utils";

// ============================================================================
// CROSSHAIR OVERLAY
// ============================================================================

export class CrosshairOverlay extends BaseOverlay {
  static readonly overlayType = "crosshair";

  private sliceH?  : SVGLineElement;
  private sliceV?  : SVGLineElement;
  private axisX?   : SVGLineElement;
  private axisY?   : SVGLineElement;
  private axisZ?   : SVGLineElement;

  private opts = {
    position  : undefined as Vec3 | undefined,
    lineWidth : 1,
  };

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.inset    = "0";
    root.style.overflow = "hidden";
  }

  protected override onMount(root: HTMLDivElement, _parent: HTMLElement): void {
    const svg = createFullscreenSvg();
    svg.style.pointerEvents = "none";
    root.appendChild(svg);

    this.sliceH = this.createLine(svg);
    this.sliceV = this.createLine(svg);
    this.axisX  = this.createLine(svg);
    this.axisY  = this.createLine(svg);
    this.axisZ  = this.createLine(svg);
    this.applyStyles();
  }

  protected override onUnmount(): void {
    this.sliceH = undefined;
    this.sliceV = undefined;
    this.axisX  = undefined;
    this.axisY  = undefined;
    this.axisZ  = undefined;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    if (Array.isArray(opts.position) && opts.position.length === 3 && opts.position.every((v) => typeof v === "number")) {
      this.opts.position = opts.position as Vec3;
    }
    if (typeof opts.lineWidth === "number") this.opts.lineWidth = opts.lineWidth;

    this.applyStyles();
  }

  protected override onHidden(): void {
    this.hideAll();
  }

  protected override onRender(state: State): void {
    const canvas = this.getCanvas();
    if (!canvas) return;

    const width  = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    const axisMap = this.getAxisMap();
    if (axisMap) {
      this.renderSlice(state, axisMap, width, height);
    } else {
      this.renderVolume(state, width, height);
    }
  }

  // ==========================================================================
  // SLICE MODE — full-viewport cross
  // ==========================================================================

  private renderSlice(state: State, axisMap: AxisMap, width: number, height: number): void {
    if (!this.sliceH || !this.sliceV) return;

    const position = this.opts.position ?? state.exploration.camera.target;
    const [px, py] = physicalToSliceScreen(position, state, axisMap, width, height);

    if (px < 0 || px > width || py < 0 || py > height) {
      this.hideAll();
      return;
    }

    this.setLine(this.sliceH, 0, py, width, py);
    this.setLine(this.sliceV, px, 0, px, height);
    this.hideAxisLines();
  }

  // ==========================================================================
  // VOLUME MODE — 3-axis reticle spanning the data bounding box
  // ==========================================================================

  private renderVolume(state: State, width: number, height: number): void {
    if (!this.axisX || !this.axisY || !this.axisZ) return;

    const camera = state.exploration.camera;
    const target = camera.target;
    const { min, max } = physicalBounds(state);

    this.setAxisLine(this.axisX, [min[0], target[1], target[2]], [max[0], target[1], target[2]], camera, width, height);
    this.setAxisLine(this.axisY, [target[0], min[1], target[2]], [target[0], max[1], target[2]], camera, width, height);
    this.setAxisLine(this.axisZ, [target[0], target[1], min[2]], [target[0], target[1], max[2]], camera, width, height);
    this.hideSliceLines();
  }

  private setAxisLine(
    line   : SVGLineElement,
    from   : Vec3,
    to     : Vec3,
    camera : State["exploration"]["camera"],
    width  : number,
    height : number,
  ): void {
    const a = physicalToVolumeScreen(from, camera, width, height);
    const b = physicalToVolumeScreen(to, camera, width, height);
    if (!a || !b) {
      line.style.display = "none";
      return;
    }
    this.setLine(line, a[0], a[1], b[0], b[1]);
  }

  // ==========================================================================
  // LINE HELPERS
  // ==========================================================================

  private createLine(svg: SVGSVGElement): SVGLineElement {
    const line = document.createElementNS(SVG_NS, "line");
    line.style.display = "none";
    svg.appendChild(line);
    return line;
  }

  private setLine(line: SVGLineElement, x1: number, y1: number, x2: number, y2: number): void {
    line.setAttribute("x1", `${x1}`);
    line.setAttribute("y1", `${y1}`);
    line.setAttribute("x2", `${x2}`);
    line.setAttribute("y2", `${y2}`);
    line.style.display = "";
  }

  private hideSliceLines(): void {
    if (this.sliceH) this.sliceH.style.display = "none";
    if (this.sliceV) this.sliceV.style.display = "none";
  }

  private hideAxisLines(): void {
    if (this.axisX) this.axisX.style.display = "none";
    if (this.axisY) this.axisY.style.display = "none";
    if (this.axisZ) this.axisZ.style.display = "none";
  }

  private hideAll(): void {
    this.hideSliceLines();
    this.hideAxisLines();
  }

  private applyStyles(): void {
    const lines = [this.sliceH, this.sliceV, this.axisX, this.axisY, this.axisZ];
    for (const line of lines) {
      if (!line) continue;
      line.style.stroke     = "var(--galavi-accent)";
      line.style.strokeWidth = `${this.opts.lineWidth}`;
    }
  }
}
