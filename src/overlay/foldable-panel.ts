/**
 * FoldablePanelOverlay — collapsible side panel hosting app-provided DOM.
 *
 * Collapsed, the panel is a slim vertical edge tab that fades in on hover and
 * opens on click. Open, it slides in from the edge (CSS transform transition)
 * with a header (uppercase micro-label + collapse chevron) and a scrollable
 * body hosting the `content` element.
 *
 * The overlay root spans the side edge of the host (`top`/`bottom` offsets)
 * with pointer-events none; the tab and panel opt back into pointer events
 * and stop propagation so the canvas below never sees their input.
 *
 * Options (all via `setOptions`):
 *   side?:         "left" | "right"        — edge to dock to (default "left").
 *   open?:         boolean                 — panel open state (default true).
 *   width?:        number                  — panel width px (default 300).
 *   label?:        string                  — header micro-label (default "panel").
 *   top?:          number                  — offset from host top px (default 0).
 *   bottom?:       number                  — offset from host bottom px (default 0).
 *   content?:      HTMLElement             — appended into the body; replaced
 *                                            when a new element arrives.
 *   onOpenChange?: (open: boolean) => void — fired on user toggles only.
 *
 * Registration: `registerOverlay("foldablepanel", () => new FoldablePanelOverlay())`.
 */

import type { State } from "../types";
import { BaseOverlay } from "./base";

// ============================================================================
// CONSTANTS
// ============================================================================

type PanelSide = "left" | "right";

const TAB_WIDTH  = 18;
const TAB_HEIGHT = 64;
const SLIDE_MS   = 220;

/** Inline SVG chevron (no icon library), colored via `currentColor`. */
function chevronSvg(direction: "left" | "right", size = 16): string {
  const path = direction === "left" ? "M10 3 L5 8 L10 13" : "M6 3 L11 8 L6 13";
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path d="${path}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ============================================================================
// FOLDABLE PANEL OVERLAY
// ============================================================================

export class FoldablePanelOverlay extends BaseOverlay {
  static readonly overlayType = "foldablepanel";

  private tabZone?    : HTMLDivElement;
  private tabBar?     : HTMLDivElement;
  private panel?      : HTMLDivElement;
  private labelEl?    : HTMLDivElement;
  private chevronBtn? : HTMLDivElement;
  private body?       : HTMLDivElement;
  private contentEl?  : HTMLElement;

  private closeTimer? : number;

  private opts = {
    side         : "left" as PanelSide,
    open         : true,
    width        : 300,
    label        : "panel",
    top          : 0,
    bottom       : 0,
    onOpenChange : undefined as ((open: boolean) => void) | undefined,
  };

  // === Lifecycle ===

  protected override onMount(root: HTMLDivElement, _parent: HTMLElement): void {
    // --- Edge tab (collapsed affordance) ---
    const tabZone = document.createElement("div");
    tabZone.style.position      = "absolute";
    tabZone.style.top           = "0";
    tabZone.style.bottom        = "0";
    tabZone.style.width         = `${TAB_WIDTH}px`;
    tabZone.style.pointerEvents = "auto";
    tabZone.style.cursor        = "pointer";
    tabZone.style.zIndex        = "2";

    const tabBar = document.createElement("div");
    tabBar.style.position       = "absolute";
    tabBar.style.top            = "50%";
    tabBar.style.transform      = "translateY(-50%)";
    tabBar.style.width          = `${TAB_WIDTH}px`;
    tabBar.style.height         = `${TAB_HEIGHT}px`;
    tabBar.style.display        = "flex";
    tabBar.style.alignItems     = "center";
    tabBar.style.justifyContent = "center";
    tabBar.style.color          = "var(--galavi-panel-bg)";
    tabBar.style.background     = "var(--galavi-accent)";
    tabBar.style.opacity        = "0";
    tabBar.style.transition     = "opacity 0.16s ease";
    tabZone.appendChild(tabBar);

    tabZone.addEventListener("click", () => this.setOpen(true, true));
    tabZone.addEventListener("pointerdown", (e) => e.stopPropagation());
    tabZone.addEventListener("mousedown", (e) => e.stopPropagation());
    tabZone.addEventListener("mouseenter", () => { tabBar.style.opacity = "0.95"; });
    tabZone.addEventListener("mouseleave", () => { tabBar.style.opacity = "0"; });

    // --- Panel ---
    const panel = document.createElement("div");
    panel.style.position      = "absolute";
    panel.style.top           = "0";
    panel.style.bottom        = "0";
    panel.style.display       = "flex";
    panel.style.flexDirection = "column";
    panel.style.boxSizing     = "border-box";
    panel.style.background    = "var(--galavi-panel-bg)";
    panel.style.pointerEvents = "auto";
    panel.style.transition    = `transform ${SLIDE_MS}ms ease`;
    panel.style.zIndex        = "1";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.style.display        = "flex";
    header.style.alignItems     = "center";
    header.style.justifyContent = "space-between";
    header.style.gap            = "8px";
    header.style.padding        = "8px 10px";
    header.style.borderBottom   = "1px solid var(--galavi-border)";
    header.style.flex           = "0 0 auto";

    const labelEl = document.createElement("div");
    labelEl.style.color         = "var(--galavi-text-dim)";
    labelEl.style.fontFamily    = "var(--galavi-font-mono)";
    labelEl.style.fontSize      = "var(--galavi-font-size)";
    labelEl.style.fontWeight    = "600";
    labelEl.style.letterSpacing = "0.12em";
    labelEl.style.textTransform = "uppercase";
    labelEl.style.whiteSpace    = "nowrap";
    labelEl.style.overflow      = "hidden";
    labelEl.style.textOverflow  = "ellipsis";

    const chevronBtn = document.createElement("div");
    chevronBtn.style.width          = "18px";
    chevronBtn.style.height         = "18px";
    chevronBtn.style.display        = "flex";
    chevronBtn.style.alignItems     = "center";
    chevronBtn.style.justifyContent = "center";
    chevronBtn.style.cursor         = "pointer";
    chevronBtn.style.color          = "var(--galavi-text-dim)";
    chevronBtn.style.transition     = "color 0.16s ease";
    chevronBtn.style.flex           = "0 0 auto";
    chevronBtn.addEventListener("click", () => this.setOpen(false, true));
    chevronBtn.addEventListener("mouseenter", () => { chevronBtn.style.color = "var(--galavi-accent)"; });
    chevronBtn.addEventListener("mouseleave", () => { chevronBtn.style.color = "var(--galavi-text-dim)"; });

    header.appendChild(labelEl);
    header.appendChild(chevronBtn);

    const body = document.createElement("div");
    body.style.flex      = "1 1 auto";
    body.style.minHeight = "0";
    body.style.overflowY = "auto";
    body.style.padding   = "10px";

    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(tabZone);
    root.appendChild(panel);

    this.tabZone    = tabZone;
    this.tabBar     = tabBar;
    this.panel      = panel;
    this.labelEl    = labelEl;
    this.chevronBtn = chevronBtn;
    this.body       = body;

    // `content` may have arrived before mount (options are set pre-mount).
    if (this.contentEl) body.appendChild(this.contentEl);

    this.syncLayout();
    this.applyOpen(false);
  }

  protected override onUnmount(): void {
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.tabZone    = undefined;
    this.tabBar     = undefined;
    this.panel      = undefined;
    this.labelEl    = undefined;
    this.chevronBtn = undefined;
    this.body       = undefined;
    // `contentEl` is kept: it belongs to the app and is re-appended on remount.
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    if (opts.side === "left" || opts.side === "right") this.opts.side = opts.side;
    if (typeof opts.open === "boolean") this.opts.open = opts.open;
    if (typeof opts.width === "number" && opts.width > 0) this.opts.width = opts.width;
    if (typeof opts.label === "string") this.opts.label = opts.label;
    if (typeof opts.top === "number") this.opts.top = opts.top;
    if (typeof opts.bottom === "number") this.opts.bottom = opts.bottom;
    if (typeof opts.onOpenChange === "function") {
      this.opts.onOpenChange = opts.onOpenChange as (open: boolean) => void;
    }
    if (opts.content instanceof HTMLElement) this.setContent(opts.content);

    this.syncLayout();
    this.applyOpen(false);
  }

  protected override onRender(_state: State): void {
    // Purely interactive overlay — nothing state-dependent to draw.
  }

  // === Behavior ===

  private setOpen(open: boolean, notify: boolean): void {
    if (this.opts.open === open) return;
    this.opts.open = open;
    this.applyOpen(true);
    if (notify) this.opts.onOpenChange?.(open);
  }

  private setContent(el: HTMLElement): void {
    if (this.contentEl === el) return;
    this.contentEl?.remove();
    this.contentEl = el;
    this.body?.appendChild(el);
  }

  /** Apply the open state to the DOM, optionally animating the slide. */
  private applyOpen(animate: boolean): void {
    if (!this.panel || !this.tabZone) return;

    const panel   = this.panel;
    const hiddenX = this.opts.side === "left" ? "-100%" : "100%";

    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }

    if (!animate) panel.style.transition = "none";

    if (this.opts.open) {
      panel.style.display        = "flex";
      panel.style.pointerEvents  = "auto";
      void panel.offsetWidth; // flush styles so the transform transition runs
      panel.style.transform      = "translateX(0)";
      this.tabZone.style.display = "none";
    } else {
      panel.style.transform      = `translateX(${hiddenX})`;
      panel.style.pointerEvents  = "none";
      this.tabZone.style.display = "block";
      // Keep the panel mounted for the slide-out, then detach it from layout.
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = undefined;
        if (!this.opts.open && this.panel) this.panel.style.display = "none";
      }, animate ? SLIDE_MS : 0);
    }

    if (!animate) {
      void panel.offsetWidth;
      panel.style.transition = "";
    }
  }

  /** (Re)apply side/width/offsets/labels to the DOM. */
  private syncLayout(): void {
    if (!this.root || !this.tabZone || !this.tabBar || !this.panel || !this.labelEl || !this.chevronBtn) return;

    const { side, width, top, bottom, label } = this.opts;
    const isLeft = side === "left";

    this.root.style.left     = isLeft ? "0" : "";
    this.root.style.right    = isLeft ? "" : "0";
    this.root.style.top      = `${top}px`;
    this.root.style.bottom   = `${bottom}px`;
    this.root.style.width    = `${Math.max(width, TAB_WIDTH)}px`;
    this.root.style.overflow = "hidden";

    this.tabZone.style.left  = isLeft ? "0" : "";
    this.tabZone.style.right = isLeft ? "" : "0";

    this.tabBar.style.left         = isLeft ? "0" : "";
    this.tabBar.style.right        = isLeft ? "" : "0";
    this.tabBar.style.borderRadius = isLeft ? "0 2px 2px 0" : "2px 0 0 2px";
    this.tabBar.title              = `Show ${label}`;
    this.tabBar.innerHTML          = chevronSvg(isLeft ? "right" : "left");

    this.panel.style.left        = isLeft ? "0" : "";
    this.panel.style.right       = isLeft ? "" : "0";
    this.panel.style.width       = `${width}px`;
    this.panel.style.borderLeft  = isLeft ? "" : "1px solid var(--galavi-border)";
    this.panel.style.borderRight = isLeft ? "1px solid var(--galavi-border)" : "";

    this.labelEl.textContent    = label;
    this.chevronBtn.title       = `Hide ${label}`;
    this.chevronBtn.innerHTML   = chevronSvg(isLeft ? "left" : "right");
  }
}
