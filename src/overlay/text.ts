/**
 * TextOverlay — DOM overlay showing region metadata labels.
 */

import type { State } from "../types";
import {
  BaseOverlay,
  type OverlayCornerPosition,
  type OverlayLabelVariant
} from "./base";

export class TextOverlay extends BaseOverlay {
  static readonly overlayType = "text";
  private labelEl?: HTMLDivElement;
  private opts = {
    text          : "",
    position      : "top-left" as OverlayCornerPosition,
    variant       : "badge" as OverlayLabelVariant,
    maxWidth      : undefined as number | string | undefined,
    regionDataIds : [] as string[],
  };

  protected override onMount(root: HTMLDivElement): void {
    const label = this.createLabel(this.opts.variant);
    root.appendChild(label);
    this.labelEl = label;
    this.applyLabelAppearance();
    this.updatePosition();
  }

  protected override onUnmount(): void {
    this.labelEl = undefined;
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    if (typeof opts.text === "string") this.opts.text = opts.text;
    if (typeof opts.position === "string") this.opts.position = opts.position as OverlayCornerPosition;
    if (typeof opts.variant === "string") this.opts.variant = opts.variant as OverlayLabelVariant;
    if (opts.maxWidth !== undefined && (typeof opts.maxWidth === "number" || typeof opts.maxWidth === "string")) {
      this.opts.maxWidth = opts.maxWidth;
    }
    if (Array.isArray(opts.regionDataIds)) this.opts.regionDataIds = opts.regionDataIds as string[];

    this.applyLabelAppearance();
    this.updatePosition();
  }

  protected override onRender(state: State): void {
    if (!this.root || !this.labelEl) return;

    let regionVisible = false;
    let labelText     = this.opts.text;
    const regionIds   = this.opts.regionDataIds.length > 0 ? this.opts.regionDataIds : this.getLayerIds();

    for (const dataId of regionIds) {
      const entry = state.layers.find((layer) => layer.id === dataId);
      if (!entry || entry.render?.visible === false) continue;

      const isRegionLayer = this.opts.regionDataIds.length > 0 || entry.type === "shapes" || entry.type === "surface";
      if (!isRegionLayer) continue;

      regionVisible = true;
      if (typeof entry.options?.regionLabel === "string") {
        labelText = entry.options.regionLabel;
      }
      break;
    }

    this.labelEl.textContent = labelText;

    const hasStaticText = this.opts.text.length > 0;
    this.root.style.display = regionVisible || hasStaticText ? this.getDisplayMode() : "none";
  }

  private applyLabelAppearance(): void {
    if (!this.labelEl) return;

    this.applyLabelStyle(this.labelEl, this.opts.variant);
    this.labelEl.style.maxWidth =
      typeof this.opts.maxWidth === "number"
        ? `${this.opts.maxWidth}px`
        : (this.opts.maxWidth ?? "none");
  }

  private updatePosition(): void {
    this.positionRoot(this.opts.position, 8);
  }
}