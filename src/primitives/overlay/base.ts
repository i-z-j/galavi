/**
 * Overlay Base Module
 *
 * BaseOverlay — abstract base for all DOM overlays.
 *
 * Overlays are presentational DOM elements bound to a live view. They MAY
 * read shared `State` in `onRender(state)` (e.g. the camera target to draw a
 * crosshair), and they own their view-local presentation state (visibility,
 * styling, position). View-local presentation is NOT part of the portable
 * `State` document and does not round-trip through `getState()`.
 *
 * Theming: overlays render with the resolved galavi theme. `BaseOverlay`
 * resolves the theme (global `ViewerRuntimeConfig.theme` merged with the per-overlay
 * `theme` option, over the neutral `DEFAULT_THEME`) and writes it as
 * `--galavi-*` CSS custom properties on the overlay root; inline styles
 * reference `var(--galavi-*)`.
 */

import type { State, Vec2, Vec3 } from "../../state/schema";
import type { ViewOwner } from "../view/base";
import type { AxisMap } from "../../utils/math/axes";
import {
  applyThemeTo,
  DEFAULT_THEME,
  mergeTheme,
  type DeepPartial,
  type GalaviTheme,
} from "./theme";

type OverlayBinding = {
  getViewType() : string;
  getLayerIds() : readonly string[];
  getCanvas()   : HTMLCanvasElement | undefined;
  isActive()    : boolean;
  getAxisMap()  : AxisMap | undefined;
  getTheme()    : GalaviTheme;
  getOwner()    : ViewOwner | undefined;
  projectPhysicalToScreen?(position: Vec3): Vec2 | null | undefined;
};

export type OverlayCornerPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type OverlayLabelVariant   = "badge" | "panel" | "tooltip";

// ============================================================================
// BASE OVERLAY
// ============================================================================

/**
 * Static contract for overlay classes registered via `overlayRegistry`. Each
 * concrete overlay declares its `overlayType` string and the registry
 * instantiates via `new cls()` directly.
 */
export interface OverlayClass {
  readonly overlayType: string;
  new (): BaseOverlay;
}

export abstract class BaseOverlay {
  protected root?: HTMLDivElement;

  private hostEl?           : HTMLElement;
  private binding?          : OverlayBinding;
  private visible           = true;
  private visibleWhenActive = false;
  private zIndex            = 10;

  private themePartial?  : DeepPartial<GalaviTheme>;
  private resolvedTheme  : GalaviTheme = DEFAULT_THEME;

  bindView(binding: OverlayBinding): void {
    this.binding = binding;
    this.updateTheme();
  }

  mount(parent: HTMLElement): void {
    this.unmount();

    const root = document.createElement("div");
    root.style.position       = "absolute";
    root.style.pointerEvents  = "none";
    root.style.zIndex         = `${this.zIndex}`;
    root.style.display        = "none";

    // Anchor the absolutely-positioned overlay root: only force `relative`
    // on statically-positioned hosts — never clobber a stylesheet position
    // (e.g. an `absolute` overlay frame), which would drop it in-flow. The
    // document body is never forced: overlays mounted there use fixed
    // positioning (stacking-context escape), and forcing `relative` on body
    // would disturb the host page's layout.
    if (parent !== parent.ownerDocument.body && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(root);

    this.root   = root;
    this.hostEl = parent;

    applyThemeTo(root, this.resolvedTheme);
    this.configureRoot(root);
    this.onMount(root, parent);
    this.syncVisibility();
  }

  unmount(): void {
    this.onUnmount();
    if (this.root?.parentElement) this.root.parentElement.removeChild(this.root);
    this.root   = undefined;
    this.hostEl = undefined;
  }

  render(state: State): void {
    if (!this.root) return;

    if (!this.isVisible(state)) {
      this.root.style.display = "none";
      this.onHidden();
      return;
    }

    this.root.style.display = this.getDisplayMode();
    this.onRender(state);
  }

  /**
   * Update view-local presentation options at runtime. Options not understood
   * by the base overlay are forwarded to `onOptionsChanged` for subclasses.
   *
   * Base options: `visible`, `visibleWhenActive`, `zIndex` (stacking order of
   * the overlay root — raise it when app chrome floats above the viewer and
   * would occlude interactive overlay UI), and `theme` (a
   * `DeepPartial<GalaviTheme>` merged over the global galavi theme).
   */
  setOptions(opts?: Record<string, unknown>): void {
    if (opts) {
      if (typeof opts.visible === "boolean") this.visible = opts.visible;
      if (typeof opts.visibleWhenActive === "boolean") this.visibleWhenActive = opts.visibleWhenActive;
      if (typeof opts.zIndex === "number" && Number.isFinite(opts.zIndex)) {
        this.zIndex = Math.max(0, Math.trunc(opts.zIndex));
        if (this.root) this.root.style.zIndex = `${this.zIndex}`;
      }
      if (opts.theme && typeof opts.theme === "object") {
        this.themePartial = opts.theme as DeepPartial<GalaviTheme>;
        this.updateTheme();
      }
      this.onOptionsChanged(opts);
    }
    this.syncVisibility();
  }

  protected configureRoot(_root: HTMLDivElement): void {}

  protected onMount(_root: HTMLDivElement, _parent: HTMLElement): void {}

  protected onUnmount(): void {}

  protected onOptionsChanged(_opts: Record<string, unknown>): void {}

  protected onHidden(): void {}

  protected abstract onRender(state: State): void;

  protected getDisplayMode(): string {
    return "block";
  }

  protected getHostElement(): HTMLElement | undefined {
    return this.hostEl;
  }

  protected getCanvas(): HTMLCanvasElement | undefined {
    return this.binding?.getCanvas();
  }

  protected getViewType(): string | undefined {
    return this.binding?.getViewType();
  }

  protected getLayerIds(): readonly string[] {
    return this.binding?.getLayerIds() ?? [];
  }

  protected isViewActive(): boolean {
    return this.binding?.isActive() ?? false;
  }

  /** Axis permutation of the bound view, or undefined for 3D views. */
  protected getAxisMap(): AxisMap | undefined {
    return this.binding?.getAxisMap();
  }

  /** The runtime owning the bound view (e.g. for follow views), as the narrow ViewOwner. */
  protected getOwner(): ViewOwner | undefined {
    return this.binding?.getOwner();
  }

  /** Project through the bound view's effective render camera when available. */
  protected projectPhysicalToScreen(position: Vec3): Vec2 | null | undefined {
    return this.binding?.projectPhysicalToScreen?.(position);
  }

  /** The resolved theme (global galavi theme + per-overlay override). */
  protected get theme(): GalaviTheme {
    return this.resolvedTheme;
  }

  /**
   * Whether the overlay should currently render. The default honors the local
   * `visible` and `visibleWhenActive` flags. Subclasses MAY override to derive
   * visibility from `state` as well, but most overlays should treat visibility
   * as view-local presentation and let the view's controller drive it via
   * `setOptions({ visible })`.
   */
  protected isVisible(_state?: State): boolean {
    return this.visible && (!this.visibleWhenActive || this.isViewActive());
  }

  protected createLabel(variant: OverlayLabelVariant, text = ""): HTMLDivElement {
    const label = document.createElement("div");
    label.textContent = text;
    this.applyLabelStyle(label, variant);
    return label;
  }

  protected positionRoot(position: OverlayCornerPosition, marginPx: number): void {
    if (!this.root) return;
    this.applyCornerPosition(this.root, position, marginPx);
  }

  protected applyCornerPosition(element: HTMLElement, position: OverlayCornerPosition, marginPx: number): void {
    const margin = `${marginPx}px`;

    element.style.left    = "";
    element.style.right   = "";
    element.style.top     = "";
    element.style.bottom  = "";

    switch (position) {
      case "top-left":
        element.style.left  = margin;
        element.style.top   = margin;
        break;
      case "top-right":
        element.style.right = margin;
        element.style.top   = margin;
        break;
      case "bottom-left":
        element.style.left    = margin;
        element.style.bottom  = margin;
        break;
      case "bottom-right":
        element.style.right   = margin;
        element.style.bottom  = margin;
        break;
    }
  }

  protected applyLabelStyle(element: HTMLElement, variant: OverlayLabelVariant): void {
    element.style.color       = "var(--galavi-text)";
    element.style.fontFamily  = "var(--galavi-font-mono)";
    element.style.fontSize    = "var(--galavi-font-size)";
    element.style.boxSizing   = "border-box";

    switch (variant) {
      case "panel":
        element.style.background    = "var(--galavi-panel-bg)";
        element.style.border        = "1px solid var(--galavi-border)";
        element.style.padding       = "8px 10px";
        element.style.borderRadius  = "2px";
        element.style.fontWeight    = "500";
        element.style.letterSpacing = "0.08em";
        element.style.lineHeight    = "1.4";
        element.style.whiteSpace    = "pre-line";
        element.style.textTransform = "uppercase";
        break;
      case "tooltip":
        element.style.background    = "var(--galavi-panel-bg)";
        element.style.border        = "none";
        element.style.padding       = "3px 8px";
        element.style.borderRadius  = "2px";
        element.style.fontWeight    = "400";
        element.style.letterSpacing = "0.04em";
        element.style.lineHeight    = "1.4";
        element.style.whiteSpace    = "pre";
        element.style.color         = "var(--galavi-text-dim)";
        break;
      default:
        element.style.background    = "var(--galavi-panel-bg)";
        element.style.border        = "1px solid var(--galavi-accent)";
        element.style.padding       = "3px 8px";
        element.style.borderRadius  = "2px";
        element.style.fontWeight    = "600";
        element.style.letterSpacing = "0.08em";
        element.style.lineHeight    = "1.2";
        element.style.whiteSpace    = "nowrap";
        element.style.color         = "var(--galavi-accent)";
        element.style.textTransform = "uppercase";
        break;
    }
  }

  protected measureElement(element: HTMLElement): { width: number; height: number } {
    const prevDisplay     = element.style.display;
    const prevVisibility  = element.style.visibility;

    element.style.visibility  = "hidden";
    element.style.display     = "block";

    const { width, height }   = element.getBoundingClientRect();

    element.style.display     = prevDisplay;
    element.style.visibility  = prevVisibility;

    return { width, height };
  }

  protected clampToCanvas(
    left    : number,
    top     : number,
    width   : number,
    height  : number,
    canvas  : HTMLCanvasElement,
    margin  : number,
  ): [number, number] {
    const maxLeft = Math.max(margin, canvas.clientWidth - width - margin);
    const maxTop  = Math.max(margin, canvas.clientHeight - height - margin);
    return [
      Math.min(Math.max(margin, left), maxLeft),
      Math.min(Math.max(margin, top), maxTop),
    ];
  }

  /** Resolve global binding theme + per-overlay override and (re)apply to root. */
  private updateTheme(): void {
    const base = this.binding?.getTheme() ?? DEFAULT_THEME;
    this.resolvedTheme = mergeTheme(base, this.themePartial);
    if (this.root) applyThemeTo(this.root, this.resolvedTheme);
  }

  private syncVisibility(): void {
    if (!this.root) return;
    this.root.style.display = this.isVisible() ? this.getDisplayMode() : "none";
  }
}
