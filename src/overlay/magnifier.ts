/**
 * MagnifierOverlay — cursor-following loupe hosting a nested galavi view.
 *
 * Port of cerevi-web's MagnifierCanvas.vue shell plus the magnifier follow
 * logic from its VolumeMode/SliceMode components. The overlay is a small
 * square canvas positioned next to the cursor; a nested `Galavi` instance
 * renders the parent view's layers into it with the camera moved closer to
 * the physical cursor position:
 *
 *   scale   = insetSize / parentViewportHeight / zoom
 *   target' = position                 (physical cursor)
 *   eye'    = target' + (parentEye − parentTarget) × scale
 *
 * The source footprint marks the exact screen area shown by the inset. The
 * inset moves around that footprint to stay within the projected data bounds,
 * with a single leader joining the nearest corners. The nested view reuses the
 * parent's view type and layer configs, so slice views keep their axis mapping
 * (carried by the slice layers) and volume views keep their projection. Parent
 * layer configs are mirrored whenever state changes, so channel selection,
 * visible channel composition, color, contrast, and slice options stay live.
 * The nested instance streams tiles through its own pipeline on its own GPU
 * device.
 *
 * Options (all via `setOptions`):
 *   position?: Vec3 | null — physical cursor position; null/undefined hides.
 *   zoom?:     number      — visual magnification (default 4, minimum 1).
 *   size?:     number      — shell edge in px; default auto
 *                            clamp(140, hostWidth/4, 320), per render pass.
 *
 * Registration: `registerOverlay("magnifier", () => new MagnifierOverlay())`.
 */

import type { State, Vec3 } from "../types";
import { physicalToSliceScreen, physicalToVolumeScreen, type AxisMap } from "../utils";
import { createGalavi, type Galavi } from "../main";
import { BaseOverlay } from "./base";

// ============================================================================
// CONSTANTS
// ============================================================================

const SVG_NS    = "http://www.w3.org/2000/svg";
const FRAME_GAP = 16;
const CORNER_SWITCH_HYSTERESIS = 4;
const GAP_EPSILON = 0.5;

/** Auto-size clamp bounds (px). */
const AUTO_SIZE_MIN = 140;
const AUTO_SIZE_MAX = 320;

interface ScreenRect {
  left   : number;
  top    : number;
  right  : number;
  bottom : number;
}

interface ScreenPoint {
  x : number;
  y : number;
}

interface MagnifierLayout {
  source           : ScreenRect;
  inset            : ScreenRect;
  connector        : { from: ScreenPoint; to: ScreenPoint };
  placement        : number;
  connectorCorners : readonly [number, number];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectWidth(rect: ScreenRect): number {
  return rect.right - rect.left;
}

function rectHeight(rect: ScreenRect): number {
  return rect.bottom - rect.top;
}

function makeRect(left: number, top: number, size: number): ScreenRect {
  return { left, top, right: left + size, bottom: top + size };
}

function rectCorners(rect: ScreenRect): ScreenPoint[] {
  return [
    { x: rect.left,  y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.left,  y: rect.bottom },
    { x: rect.right, y: rect.bottom },
  ];
}

function overflow(rect: ScreenRect, bounds: ScreenRect): number {
  return (
    Math.max(bounds.left - rect.left, 0) +
    Math.max(rect.right - bounds.right, 0) +
    Math.max(bounds.top - rect.top, 0) +
    Math.max(rect.bottom - bounds.bottom, 0)
  );
}

function cornerDistance(first: ScreenPoint, second: ScreenPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function closestCorners(
  first    : ScreenRect,
  second   : ScreenRect,
  previous : readonly [number, number] | undefined,
): Pick<MagnifierLayout, "connector" | "connectorCorners"> {
  const firstCorners  = rectCorners(first);
  const secondCorners = rectCorners(second);
  let bestCorners: readonly [number, number] = [0, 0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let firstIndex = 0; firstIndex < firstCorners.length; firstIndex++) {
    for (let secondIndex = 0; secondIndex < secondCorners.length; secondIndex++) {
      const firstCorner  = firstCorners[firstIndex];
      const secondCorner = secondCorners[secondIndex];
      const dx       = secondCorner.x - firstCorner.x;
      const dy       = secondCorner.y - firstCorner.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCorners  = [firstIndex, secondIndex];
      }
    }
  }

  if (previous) {
    const previousDistance = cornerDistance(
      firstCorners[previous[0]],
      secondCorners[previous[1]],
    );
    if (previousDistance <= Math.sqrt(bestDistance) + CORNER_SWITCH_HYSTERESIS) {
      bestCorners = previous;
    }
  }

  return {
    connector: {
      from : firstCorners[bestCorners[0]],
      to   : secondCorners[bestCorners[1]],
    },
    connectorCorners: bestCorners,
  };
}

function clampInset(candidate: ScreenRect, bounds: ScreenRect, size: number): ScreenRect {
  return makeRect(
    clamp(candidate.left, bounds.left, bounds.right - size),
    clamp(candidate.top, bounds.top, bounds.bottom - size),
    size,
  );
}

function keepsFrameGap(source: ScreenRect, inset: ScreenRect): boolean {
  const horizontalGap = Math.max(inset.left - source.right, source.left - inset.right, 0);
  const verticalGap   = Math.max(inset.top - source.bottom, source.top - inset.bottom, 0);
  return (
    horizontalGap >= FRAME_GAP - GAP_EPSILON ||
    verticalGap >= FRAME_GAP - GAP_EPSILON
  );
}

function layoutMagnifier(
  cursor                   : readonly [number, number],
  bounds                   : ScreenRect,
  insetSize                : number,
  zoom                     : number,
  previousPlacement        : number | undefined,
  previousConnectorCorners : readonly [number, number] | undefined,
): MagnifierLayout {
  const sourceSize = Math.min(insetSize / zoom, insetSize, rectWidth(bounds), rectHeight(bounds));
  const sourceLeft = clamp(cursor[0] - sourceSize / 2, bounds.left, bounds.right - sourceSize);
  const sourceTop  = clamp(cursor[1] - sourceSize / 2, bounds.top, bounds.bottom - sourceSize);
  const source     = makeRect(sourceLeft, sourceTop, sourceSize);
  const centerX    = (source.left + source.right) / 2;
  const centerY    = (source.top + source.bottom) / 2;

  const candidates = [
    makeRect(source.right + FRAME_GAP, source.top - FRAME_GAP - insetSize, insetSize),
    makeRect(centerX - insetSize / 2, source.top - FRAME_GAP - insetSize, insetSize),
    makeRect(source.right + FRAME_GAP, centerY - insetSize / 2, insetSize),
    makeRect(source.left - FRAME_GAP - insetSize, source.top - FRAME_GAP - insetSize, insetSize),
    makeRect(source.right + FRAME_GAP, source.bottom + FRAME_GAP, insetSize),
    makeRect(source.left - FRAME_GAP - insetSize, centerY - insetSize / 2, insetSize),
    makeRect(centerX - insetSize / 2, source.bottom + FRAME_GAP, insetSize),
    makeRect(source.left - FRAME_GAP - insetSize, source.bottom + FRAME_GAP, insetSize),
  ];
  let placement = 0;
  if (
    previousPlacement !== undefined &&
    candidates[previousPlacement] &&
    keepsFrameGap(source, clampInset(candidates[previousPlacement], bounds, insetSize))
  ) {
    placement = previousPlacement;
  } else {
    let bestScore = overflow(candidates[0], bounds);
    for (let index = 1; index < candidates.length; index++) {
      const score = overflow(candidates[index], bounds);
      if (score < bestScore) {
        placement = index;
        bestScore = score;
      }
    }
  }

  const inset = clampInset(candidates[placement], bounds, insetSize);
  return {
    source,
    inset,
    placement,
    ...closestCorners(source, inset, previousConnectorCorners),
  };
}

function projectedImageBounds(
  state   : State,
  axisMap : AxisMap | undefined,
  width   : number,
  height  : number,
): ScreenRect {
  const viewport = { left: 0, top: 0, right: width, bottom: height };
  const spatial  = state.physical?.spatial;
  if (!spatial) return viewport;

  const origin = spatial.origin ?? [0, 0, 0];
  const end: Vec3 = [
    origin[0] + spatial.size[0],
    origin[1] + spatial.size[1],
    origin[2] + spatial.size[2],
  ];
  const projected: Array<readonly [number, number]> = [];
  for (const x of [origin[0], end[0]]) {
    for (const y of [origin[1], end[1]]) {
      for (const z of [origin[2], end[2]]) {
        const point: Vec3 = [x, y, z];
        const screen = axisMap
          ? physicalToSliceScreen(point, state, axisMap, width, height)
          : physicalToVolumeScreen(point, state.exploration.camera, width, height);
        if (screen && screen.every(Number.isFinite)) projected.push(screen);
      }
    }
  }
  if (projected.length === 0) return viewport;

  const bounds: ScreenRect = {
    left   : Math.max(0, Math.min(...projected.map((point) => point[0]))),
    top    : Math.max(0, Math.min(...projected.map((point) => point[1]))),
    right  : Math.min(width, Math.max(...projected.map((point) => point[0]))),
    bottom : Math.min(height, Math.max(...projected.map((point) => point[1]))),
  };
  return rectWidth(bounds) > 0 && rectHeight(bounds) > 0 ? bounds : viewport;
}

// ============================================================================
// MAGNIFIER OVERLAY
// ============================================================================

export class MagnifierOverlay extends BaseOverlay {
  static readonly overlayType = "magnifier";

  private shell?  : HTMLDivElement;
  private source? : SVGRectElement;
  private leader? : SVGLineElement;
  private nested? : Galavi;

  private mountToken    = 0;
  private lastSize      = 0;
  private viewportHeight = 0;
  private lastFollowKey = "";
  private lastLayers?   : State["layers"];
  private lastPlacement? : number;
  private lastConnectorCorners? : readonly [number, number];

  private opts = {
    position : null as Vec3 | null,
    zoom     : 4,
    size     : undefined as number | undefined,
  };

  // === Lifecycle ===

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.overflow = "hidden";
  }

  protected override onMount(root: HTMLDivElement, _parent: HTMLElement): void {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.style.position      = "absolute";
    svg.style.inset         = "0";
    svg.style.width         = "100%";
    svg.style.height        = "100%";
    svg.style.pointerEvents = "none";

    const leader = document.createElementNS(SVG_NS, "line");
    leader.style.stroke          = "var(--galavi-accent)";
    leader.style.strokeWidth     = "1";
    leader.style.strokeLinecap   = "square";
    leader.style.vectorEffect    = "non-scaling-stroke";

    const source = document.createElementNS(SVG_NS, "rect");
    source.style.fill         = "none";
    source.style.stroke       = "var(--galavi-accent)";
    source.style.strokeWidth  = "1";
    source.style.vectorEffect = "non-scaling-stroke";

    svg.appendChild(leader);
    svg.appendChild(source);
    root.appendChild(svg);

    const shell = document.createElement("div");
    shell.style.position      = "absolute";
    shell.style.display       = "none";
    shell.style.overflow      = "hidden";
    shell.style.boxSizing     = "border-box";
    shell.style.outline       = "1px solid var(--galavi-accent)";
    shell.style.outlineOffset = "-1px";
    shell.style.background    = "var(--galavi-panel-bg)";
    shell.style.pointerEvents = "none";

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width   = "100%";
    canvas.style.height  = "100%";

    shell.appendChild(canvas);
    root.appendChild(shell);

    this.shell  = shell;
    this.source = source;
    this.leader = leader;

    void this.mountNested(canvas);
  }

  protected override onUnmount(): void {
    // Invalidate any in-flight async mount, then tear down the live instance.
    this.mountToken++;
    const nested = this.nested;
    this.nested = undefined;
    nested?.destroy();

    this.shell         = undefined;
    this.source        = undefined;
    this.leader        = undefined;
    this.lastSize      = 0;
    this.viewportHeight = 0;
    this.lastFollowKey = "";
    this.lastLayers    = undefined;
    this.resetLayoutPreference();
  }

  protected override onOptionsChanged(opts: Record<string, unknown>): void {
    const p = opts.position;
    if (p === null) {
      this.opts.position = null;
      this.resetLayoutPreference();
    } else if (
      Array.isArray(p) &&
      p.length === 3 &&
      p.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      this.opts.position = [p[0], p[1], p[2]];
    }
    if (typeof opts.zoom === "number" && Number.isFinite(opts.zoom) && opts.zoom > 0) {
      this.opts.zoom = Math.max(opts.zoom, 1);
    }
    if (typeof opts.size === "number" && Number.isFinite(opts.size) && opts.size > 0) this.opts.size = opts.size;
  }

  protected override onHidden(): void {
    this.resetLayoutPreference();
  }

  // === Render ===

  protected override onRender(state: State): void {
    if (!this.root || !this.shell || !this.source || !this.leader) return;

    const position = this.opts.position;
    const canvas   = this.getCanvas();
    if (!position || !canvas) {
      this.root.style.display = "none";
      return;
    }

    const width  = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) {
      this.root.style.display = "none";
      return;
    }
    this.alignRootToCanvas(canvas, width, height);

    const axisMap = this.getAxisMap();
    const screen  = axisMap
      ? physicalToSliceScreen(position, state, axisMap, width, height)
      : physicalToVolumeScreen(position, state.exploration.camera, width, height);
    if (!screen) {
      this.root.style.display = "none";
      return;
    }

    const bounds = projectedImageBounds(state, axisMap, width, height);
    if (
      screen[0] < bounds.left || screen[0] > bounds.right ||
      screen[1] < bounds.top  || screen[1] > bounds.bottom
    ) {
      this.root.style.display = "none";
      return;
    }

    const size   = this.resolveSize(bounds);
    const zoom   = Math.max(this.opts.zoom, 1);
    const layout = layoutMagnifier(
      screen,
      bounds,
      size,
      zoom,
      this.lastPlacement,
      this.lastConnectorCorners,
    );
    this.lastPlacement        = layout.placement;
    this.lastConnectorCorners = layout.connectorCorners;
    this.viewportHeight = height;
    if (size !== this.lastSize) {
      this.lastSize           = size;
      this.shell.style.width  = `${size}px`;
      this.shell.style.height = `${size}px`;
      // The nested view only resizes its drawing buffer on render.
      this.nested?.requestRender();
    }

    this.root.style.display = "block";
    this.shell.style.display = "block";
    this.shell.style.left    = `${layout.inset.left}px`;
    this.shell.style.top     = `${layout.inset.top}px`;

    this.source.setAttribute("x", `${layout.source.left}`);
    this.source.setAttribute("y", `${layout.source.top}`);
    this.source.setAttribute("width", `${rectWidth(layout.source)}`);
    this.source.setAttribute("height", `${rectHeight(layout.source)}`);
    this.leader.setAttribute("x1", `${layout.connector.from.x}`);
    this.leader.setAttribute("y1", `${layout.connector.from.y}`);
    this.leader.setAttribute("x2", `${layout.connector.to.x}`);
    this.leader.setAttribute("y2", `${layout.connector.to.y}`);

    this.syncNested(state);
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
        theme: owner.theme,
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
    this.lastLayers    = undefined;
    this.syncNested(owner.getState());
  }

  /** Push the parent camera and live layer configs into the nested instance. */
  private syncNested(state: State): void {
    const nested = this.nested;
    if (!nested) return;

    const cam = state.exploration.camera;
    const pos = this.opts.position;
    if (!pos) return;

    const key = [
      pos[0], pos[1], pos[2],
      cam.position[0], cam.position[1], cam.position[2],
      cam.target[0], cam.target[1], cam.target[2],
      Math.max(this.opts.zoom, 1),
      this.lastSize,
      this.viewportHeight,
    ].join(",");
    const layersChanged = state.layers !== this.lastLayers;
    if (key === this.lastFollowKey && !layersChanged) return;

    const next = nested.getState();
    if (layersChanged) next.layers = state.layers;
    this.applyFollowCamera(next, state.exploration.camera);
    nested.setState(next);

    this.lastFollowKey = key;
    this.lastLayers    = state.layers;
  }

  /**
   * Rewrite `state`'s camera to the follow camera, preserving the parent view
   * direction while matching the inset's pixel footprint. Mutates the cloned
   * destination state in place.
   */
  private applyFollowCamera(
    state        : State,
    sourceCamera = state.exploration.camera,
  ): void {
    const position = this.opts.position;
    if (!position) return;

    const zoom  = Math.max(this.opts.zoom, 1);
    const scale = this.lastSize > 0 && this.viewportHeight > 0
      ? this.lastSize / this.viewportHeight / zoom
      : 1 / zoom;

    state.exploration.camera = {
      ...sourceCamera,
      target   : [...position] as Vec3,
      position : [
        position[0] + (sourceCamera.position[0] - sourceCamera.target[0]) * scale,
        position[1] + (sourceCamera.position[1] - sourceCamera.target[1]) * scale,
        position[2] + (sourceCamera.position[2] - sourceCamera.target[2]) * scale,
      ] as Vec3,
    };
  }

  private alignRootToCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
    if (!this.root) return;

    const hostRect   = this.getHostElement()?.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const hasLayout  = canvasRect.width > 0 || canvasRect.height > 0;
    const left       = hostRect && hasLayout ? canvasRect.left - hostRect.left : canvas.offsetLeft;
    const top        = hostRect && hasLayout ? canvasRect.top - hostRect.top : canvas.offsetTop;

    this.root.style.left   = `${left}px`;
    this.root.style.top    = `${top}px`;
    this.root.style.width  = `${width}px`;
    this.root.style.height = `${height}px`;
  }

  private resolveSize(bounds: ScreenRect): number {
    const available = Math.max(1, Math.floor(Math.min(rectWidth(bounds), rectHeight(bounds))));
    if (typeof this.opts.size === "number") return Math.min(this.opts.size, available);
    const hostWidth = this.getHostElement()?.clientWidth ?? 0;
    const desired   = Math.round(Math.max(AUTO_SIZE_MIN, Math.min(AUTO_SIZE_MAX, hostWidth / 4)));
    return Math.min(desired, available);
  }

  private resetLayoutPreference(): void {
    this.lastPlacement        = undefined;
    this.lastConnectorCorners = undefined;
  }
}
