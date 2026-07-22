/**
 * MagnifierOverlay — cursor-following loupe hosting a nested galavi view.
 *
 * Port of cerevi-web's MagnifierCanvas.vue shell plus the magnifier follow
 * logic from its VolumeMode/SliceMode components. The overlay is a small
 * square canvas positioned next to the cursor; a nested `Galavi` instance
 * renders the parent view's layers into it with the camera moved closer to
 * the physical cursor position:
 *
 *   offset  = (parentCam.position − parentCam.target) / zoom
 *   target' = position                 (physical cursor)
 *   eye'    = target' + offset
 *
 * The nested view reuses the parent's view type and layer configs, so slice
 * views keep their axis mapping (carried by the slice layers) and volume
 * views keep their projection. Camera follow is the only live sync — layer
 * render/option changes made after the nested instance mounts do not
 * propagate (the nested instance snapshots `owner.getState()` at mount and
 * streams tiles through its own pipeline on its own GPU device).
 *
 * Options (all via `setOptions`):
 *   position?: Vec3 | null — physical cursor position; null/undefined hides.
 *   zoom?:     number      — camera distance divisor (default 4).
 *   size?:     number      — shell edge in px; default auto
 *                            clamp(140, hostWidth/4, 320), per render pass.
 *
 * Registration: `registerOverlay("magnifier", () => new MagnifierOverlay())`.
 */

import type { State, Vec3 } from "../types";
import { physicalToSliceScreen, physicalToVolumeScreen } from "../utils";
import { createGalavi, type Galavi } from "../main";
import { BaseOverlay } from "./base";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Shell offset from the cursor (matches cerevi's MagnifierCanvas). */
const OFFSET_X = 16;
const OFFSET_Y = 16;

/** Auto-size clamp bounds (px). */
const AUTO_SIZE_MIN = 140;
const AUTO_SIZE_MAX = 320;

// ============================================================================
// MAGNIFIER OVERLAY
// ============================================================================

export class MagnifierOverlay extends BaseOverlay {
  static readonly overlayType = "magnifier";

  private shell?  : HTMLDivElement;
  private nested? : Galavi;

  private mountToken    = 0;
  private lastSize      = 0;
  private lastFollowKey = "";

  private opts = {
    position : null as Vec3 | null,
    zoom     : 4,
    size     : undefined as number | undefined,
  };

  // === Lifecycle ===

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.inset    = "0";
    root.style.overflow = "hidden";
  }

  protected override onMount(root: HTMLDivElement, _parent: HTMLElement): void {
    const shell = document.createElement("div");
    shell.style.position      = "absolute";
    shell.style.display       = "none";
    shell.style.overflow      = "hidden";
    shell.style.border        = "1px solid var(--galavi-accent)";
    shell.style.borderRadius  = "2px";
    shell.style.background    = "var(--galavi-panel-bg)";
    shell.style.boxShadow     = "0 0 14px var(--galavi-accent-soft), 0 8px 24px rgba(0, 0, 0, 0.45)";
    shell.style.pointerEvents = "none";

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width   = "100%";
    canvas.style.height  = "100%";

    shell.appendChild(canvas);
    root.appendChild(shell);

    this.shell = shell;

    void this.mountNested(canvas);
  }

  protected override onUnmount(): void {
    // Invalidate any in-flight async mount, then tear down the live instance.
    this.mountToken++;
    const nested = this.nested;
    this.nested = undefined;
    nested?.destroy();

    this.shell         = undefined;
    this.lastSize      = 0;
    this.lastFollowKey = "";
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    const p = opts.position;
    if (p === null) {
      this.opts.position = null;
    } else if (
      Array.isArray(p) &&
      p.length === 3 &&
      p.every((v) => typeof v === "number")
    ) {
      this.opts.position = [p[0], p[1], p[2]];
    }
    if (typeof opts.zoom === "number" && opts.zoom > 0) this.opts.zoom = opts.zoom;
    if (typeof opts.size === "number" && opts.size > 0) this.opts.size = opts.size;
  }

  // === Render ===

  protected override onRender(state: State): void {
    if (!this.root || !this.shell) return;

    const position = this.opts.position;
    const canvas   = this.getCanvas();
    if (!position || !canvas) {
      this.root.style.display = "none";
      return;
    }

    // Project the physical cursor position into host pixels to place the shell.
    const axisMap = this.getAxisMap();
    const screen  = axisMap
      ? physicalToSliceScreen(position, state, axisMap, canvas.clientWidth, canvas.clientHeight)
      : physicalToVolumeScreen(position, state.exploration.camera, canvas.clientWidth, canvas.clientHeight);
    if (!screen) {
      this.root.style.display = "none";
      return;
    }

    const size = this.resolveSize();
    if (size !== this.lastSize) {
      this.lastSize           = size;
      this.shell.style.width  = `${size}px`;
      this.shell.style.height = `${size}px`;
      // The nested view only resizes its drawing buffer on render.
      this.nested?.requestRender();
    }

    this.root.style.display = "block";
    this.shell.style.left   = `${screen[0] + OFFSET_X}px`;
    this.shell.style.top    = `${screen[1] - size - OFFSET_Y}px`;

    this.syncFollow(state);
  }

  // === Nested view ===

  /**
   * Create the nested Galavi instance on the overlay canvas. Async — an
   * unmount (or remount) racing the GPU init invalidates the result via
   * `mountToken`, mirroring cerevi's magnifier token guard.
   */
  private async mountNested(canvas: HTMLCanvasElement): Promise<void> {
    const owner    = this.getOwner();
    const viewType = this.getViewType();
    const layerIds = this.getLayerIds();
    if (!owner || !viewType || layerIds.length === 0) return;

    const token = ++this.mountToken;
    const state = owner.getState();
    this.applyFollowCamera(state);

    let instance: Galavi;
    try {
      instance = await createGalavi({
        state,
        views: {
          magnifier: {
            type        : viewType,
            canvas,
            layers      : [...layerIds],
            activatable : false,
          },
        },
      });
    } catch (e) {
      console.warn("[MagnifierOverlay] nested view init failed:", e);
      return;
    }

    if (token !== this.mountToken) {
      instance.destroy();
      return;
    }

    this.nested        = instance;
    this.lastFollowKey = "";
  }

  /** Push the follow camera into the nested instance when inputs changed. */
  private syncFollow(state: State): void {
    const nested = this.nested;
    if (!nested) return;

    const cam = state.exploration.camera;
    const pos = this.opts.position;
    if (!pos) return;

    const key = [
      pos[0], pos[1], pos[2],
      cam.position[0], cam.position[1], cam.position[2],
      cam.target[0], cam.target[1], cam.target[2],
      this.opts.zoom,
    ].join(",");
    if (key === this.lastFollowKey) return;
    this.lastFollowKey = key;

    const next = nested.getState();
    this.applyFollowCamera(next);
    nested.setState(next);
  }

  /**
   * Rewrite `state`'s camera to the follow camera: parent view direction,
   * distance divided by `zoom`, focused on the `position` option. Mutates the
   * (already cloned) state in place.
   */
  private applyFollowCamera(state: State): void {
    const position = this.opts.position;
    if (!position) return;

    const cam  = state.exploration.camera;
    const zoom = Math.max(this.opts.zoom, 1e-6);

    state.exploration.camera = {
      ...cam,
      target   : [...position] as Vec3,
      position : [
        position[0] + (cam.position[0] - cam.target[0]) / zoom,
        position[1] + (cam.position[1] - cam.target[1]) / zoom,
        position[2] + (cam.position[2] - cam.target[2]) / zoom,
      ] as Vec3,
    };
  }

  private resolveSize(): number {
    if (typeof this.opts.size === "number") return this.opts.size;
    const hostWidth = this.getHostElement()?.clientWidth ?? 0;
    return Math.round(Math.max(AUTO_SIZE_MIN, Math.min(AUTO_SIZE_MAX, hostWidth / 4)));
  }
}
