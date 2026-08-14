/**
 * Cursor-linked magnifier overlay with mutually exclusive 2D and 3D variants.
 *
 * The 2D variant retains the original dynamic pixel footprint and follow
 * camera. The 3D variant renders an exact level-0 voxel crop through the
 * existing tiled volume view: coarse cached tiles can provide an immediate
 * fallback, then the crop refines to level 0. Storage requests remain whole
 * chunks and superseded plans are aborted by TileManager.
 */

import type { LayerConfig, PhysicalSpace, State, Vec3 } from "../types";
import {
  cameraAngles,
  cameraDistance,
  computePosition,
  physicalToSliceScreen,
  physicalToVolumeScreen,
  type AxisMap,
} from "../utils";
import {
  computeMagnifierVoxelRegion,
  type MagnifierRegion,
} from "../utils/magnifier-region";
import {
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_TARGET,
  DEFAULT_FOV,
} from "../defaults";
import type { ViewerEngine } from "../viewer";
import { BaseOverlay } from "./base";
import { SVG_NS, clamp, createFullscreenSvg, physicalBounds } from "./utils";

const FRAME_GAP = 16;
const PANEL_GAP = 0;
const PANEL_WIDTH = 184;
const PANEL_TAB_WIDTH = 26;
const CORNER_SWITCH_HYSTERESIS = 4;
const GAP_EPSILON = 0.5;
const AUTO_SIZE_MIN = 140;
const AUTO_SIZE_MAX = 320;
const DEFAULT_3D_VOXEL_EXTENT = 32;
const VOXEL_EXTENT_STEPS = [16, 32, 64] as const;
const SPIN_SPEED_DEG_PER_SEC = 12;
const SPIN_RESUME_DELAY_MS = 1000;
const BLOCK_FRAME_MARGIN = 1.12;

export type MagnifierDimension = "2d" | "3d";

export interface MagnifierOptions {
  /** Region center in world coordinates; null removes all magnifier artifacts. */
  position?      : Vec3 | null;
  /** 2D visual magnification. Default: 4. */
  zoom?          : number;
  /** Inset edge in CSS pixels. Default: responsive 140–320 px. */
  size?          : number;
  /** 3D level-0 voxel extent on every axis. Default: 32. */
  voxelExtent3d? : number;
  /** Optional alternate tiled layer IDs. */
  layers?        : string[];
}

const DEFAULT_VIEW_OFFSET: Vec3 = [
  DEFAULT_CAMERA_POSITION[0] - DEFAULT_CAMERA_TARGET[0],
  DEFAULT_CAMERA_POSITION[1] - DEFAULT_CAMERA_TARGET[1],
  DEFAULT_CAMERA_POSITION[2] - DEFAULT_CAMERA_TARGET[2],
];

interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ScreenPoint { x: number; y: number }
type PanelSide = "left" | "right";

interface MagnifierLayout {
  source           : ScreenRect;
  inset            : ScreenRect;
  connector        : { from: ScreenPoint; to: ScreenPoint };
  connectorCorners : readonly [number, number];
  placement        : number;
  panelSide        : PanelSide;
}

interface PreparedLayer {
  id      : string;
  source  : LayerConfig;
  wrapped : LayerConfig;
  region  : MagnifierRegion;
  corners : Vec3[];
}

interface PreparedMagnifier {
  layers      : LayerConfig[];
  selected    : PreparedLayer[];
  reference   : PreparedLayer;
  selectedIds : string[];
}

interface ChannelSetting {
  visible  : boolean;
  contrast : [number, number];
  color?   : string;
  label    : string;
}

function rectWidth(rect: ScreenRect): number { return rect.right - rect.left; }
function rectHeight(rect: ScreenRect): number { return rect.bottom - rect.top; }
function rectCenterX(rect: ScreenRect): number { return (rect.left + rect.right) / 2; }
function rectCenterY(rect: ScreenRect): number { return (rect.top + rect.bottom) / 2; }

function makeRect(left: number, top: number, size: number): ScreenRect {
  return { left, top, right: left + size, bottom: top + size };
}

function rectCorners(rect: ScreenRect): ScreenPoint[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.left, y: rect.bottom },
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

function panelSideFor(source: ScreenRect, inset: ScreenRect): PanelSide {
  return rectCenterX(inset) >= rectCenterX(source) ? "right" : "left";
}

function framedInset(inset: ScreenRect, side: PanelSide, panelWidth: number): ScreenRect {
  if (panelWidth <= 0) return inset;
  return side === "right"
    ? { ...inset, right: inset.right + PANEL_GAP + panelWidth }
    : { ...inset, left: inset.left - PANEL_GAP - panelWidth };
}

function clampInset(
  candidate: ScreenRect,
  bounds: ScreenRect,
  size: number,
  side: PanelSide,
  panelWidth: number,
): ScreenRect {
  const reserveLeft = side === "left" ? panelWidth + PANEL_GAP : 0;
  const reserveRight = side === "right" ? panelWidth + PANEL_GAP : 0;
  let minLeft = bounds.left + reserveLeft;
  let maxLeft = bounds.right - size - reserveRight;
  if (maxLeft < minLeft) {
    minLeft = bounds.left;
    maxLeft = bounds.right - size;
  }
  return makeRect(
    clamp(candidate.left, minLeft, maxLeft),
    clamp(candidate.top, bounds.top, bounds.bottom - size),
    size,
  );
}

function keepsFrameGap(source: ScreenRect, inset: ScreenRect): boolean {
  const horizontalGap = Math.max(inset.left - source.right, source.left - inset.right, 0);
  const verticalGap = Math.max(inset.top - source.bottom, source.top - inset.bottom, 0);
  return horizontalGap >= FRAME_GAP - GAP_EPSILON || verticalGap >= FRAME_GAP - GAP_EPSILON;
}

function cornerDistance(first: ScreenPoint, second: ScreenPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function closestCorners(
  first: ScreenRect,
  second: ScreenRect,
  previous: readonly [number, number] | undefined,
): Pick<MagnifierLayout, "connector" | "connectorCorners"> {
  const firstCorners = rectCorners(first);
  const secondCorners = rectCorners(second);
  let bestCorners: readonly [number, number] = [0, 0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < firstCorners.length; firstIndex++) {
    for (let secondIndex = 0; secondIndex < secondCorners.length; secondIndex++) {
      const dx = secondCorners[secondIndex].x - firstCorners[firstIndex].x;
      const dy = secondCorners[secondIndex].y - firstCorners[firstIndex].y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCorners = [firstIndex, secondIndex];
      }
    }
  }
  if (previous) {
    const previousDistance = cornerDistance(firstCorners[previous[0]], secondCorners[previous[1]]);
    if (previousDistance <= Math.sqrt(bestDistance) + CORNER_SWITCH_HYSTERESIS) {
      bestCorners = previous;
    }
  }
  return {
    connector: { from: firstCorners[bestCorners[0]], to: secondCorners[bestCorners[1]] },
    connectorCorners: bestCorners,
  };
}

function layoutMagnifier(
  source: ScreenRect,
  bounds: ScreenRect,
  insetSize: number,
  panelWidth: number,
  previousPlacement: number | undefined,
  previousConnectorCorners: readonly [number, number] | undefined,
): MagnifierLayout {
  const centerX = rectCenterX(source);
  const centerY = rectCenterY(source);
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
  const resolved = candidates.map((candidate) => {
    const side = panelSideFor(source, candidate);
    const inset = clampInset(candidate, bounds, insetSize, side, panelWidth);
    return { inset, side, score: overflow(framedInset(candidate, side, panelWidth), bounds) };
  });
  let placement = 0;
  if (
    previousPlacement !== undefined && resolved[previousPlacement] &&
    keepsFrameGap(source, resolved[previousPlacement].inset)
  ) {
    placement = previousPlacement;
  } else {
    for (let index = 1; index < resolved.length; index++) {
      if (resolved[index].score < resolved[placement].score) placement = index;
    }
  }
  const { inset, side } = resolved[placement];
  return {
    source,
    inset,
    placement,
    panelSide: side,
    ...closestCorners(source, inset, previousConnectorCorners),
  };
}

function layerModelMatrix(desc: LayerConfig, physical?: PhysicalSpace): Float32Array {
  const transform = desc.data?.transform;
  if (transform?.length === 16) return new Float32Array(transform);
  const size = physical?.spatial.size ?? [1, 1, 1];
  const origin = physical?.spatial.origin ?? [0, 0, 0];
  return new Float32Array([
    size[0], 0, 0, 0,
    0, size[1], 0, 0,
    0, 0, size[2], 0,
    origin[0], origin[1], origin[2], 1,
  ]);
}

function transformPoint(matrix: Float32Array, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function regionCorners(model: Float32Array, region: MagnifierRegion): Vec3[] {
  const corners: Vec3[] = [];
  for (const z of [region.normalizedBounds.min[2], region.normalizedBounds.max[2]]) {
    for (const y of [region.normalizedBounds.min[1], region.normalizedBounds.max[1]]) {
      for (const x of [region.normalizedBounds.min[0], region.normalizedBounds.max[0]]) {
        corners.push(transformPoint(model, [x, y, z]));
      }
    }
  }
  return corners;
}

function projectedRect(
  corners: Vec3[],
  state: State,
  axisMap: AxisMap | undefined,
  width: number,
  height: number,
): ScreenRect | undefined {
  const projected = corners.flatMap((point) => {
    const screen = axisMap
      ? physicalToSliceScreen(point, state, axisMap, width, height)
      : physicalToVolumeScreen(point, state.exploration.camera, width, height);
    return screen && screen.every(Number.isFinite) ? [screen] : [];
  });
  if (projected.length === 0) return undefined;
  return {
    left: Math.min(...projected.map((point) => point[0])),
    top: Math.min(...projected.map((point) => point[1])),
    right: Math.max(...projected.map((point) => point[0])),
    bottom: Math.max(...projected.map((point) => point[1])),
  };
}

function projectedImageBounds(
  state: State,
  axisMap: AxisMap | undefined,
  width: number,
  height: number,
): ScreenRect {
  const viewport = { left: 0, top: 0, right: width, bottom: height };
  if (!state.physical?.spatial) return viewport;
  const { min, max } = physicalBounds(state);
  const corners: Vec3[] = [];
  for (const z of [min[2], max[2]]) {
    for (const y of [min[1], max[1]]) {
      for (const x of [min[0], max[0]]) corners.push([x, y, z]);
    }
  }
  const projected = projectedRect(corners, state, axisMap, width, height);
  if (!projected) return viewport;
  const bounds = {
    left: Math.max(0, projected.left),
    top: Math.max(0, projected.top),
    right: Math.min(width, projected.right),
    bottom: Math.min(height, projected.bottom),
  };
  return rectWidth(bounds) > 0 && rectHeight(bounds) > 0 ? bounds : viewport;
}

function arraysEqual(first?: readonly string[], second?: readonly string[]): boolean {
  return first === second || !!first && !!second &&
    first.length === second.length && first.every((value, index) => value === second[index]);
}

function nearestVoxelExtent(value: number): 16 | 32 | 64 {
  return VOXEL_EXTENT_STEPS.reduce((nearest, candidate) => (
    Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest
  ));
}

export class MagnifierOverlay extends BaseOverlay {
  static readonly overlayType = "magnifier-2d";

  private shell?: HTMLDivElement;
  private canvasEl?: HTMLCanvasElement;
  private source?: SVGRectElement;
  private leader?: SVGLineElement;
  private loadingEl?: HTMLDivElement;
  private sizeReadout?: HTMLSpanElement;
  private sizeDecrease?: HTMLButtonElement;
  private sizeIncrease?: HTMLButtonElement;
  private channelPanel?: HTMLDivElement;
  private channelTab?: HTMLButtonElement;
  private channelPanelOpen = true;
  private nested?: ViewerEngine;
  private nestedMounting = false;
  private mountToken = 0;
  private mountedLayerIds: string[] = [];
  private animationFrameId?: number;
  private spinLastTs = 0;
  private spinPaused = false;
  private spinResumeTimer?: number;
  private renderActive = false;
  private lastFollowKey = "";
  private lastLayers?: State["layers"];
  private lastSize = 0;
  private viewportHeight = 0;
  private lastPlacement?: number;
  private lastConnectorCorners?: readonly [number, number];
  private panelKey = "";
  private channelSettings = new Map<string, ChannelSetting>();
  private panelCleanup: Array<() => void> = [];
  private opts: MagnifierOptions & { zoom: number; voxelExtent3d: number } = {
    position: null,
    zoom: 4,
    voxelExtent3d: DEFAULT_3D_VOXEL_EXTENT,
  };

  constructor(private readonly dimension: MagnifierDimension = "2d") {
    super();
  }

  protected override configureRoot(root: HTMLDivElement): void {
    root.style.overflow = "hidden";
    if (this.dimension === "3d") {
      // The 3D root is mounted on the document body and tracks the canvas in
      // fixed viewport coordinates (see `mount`): an ancestor with its own
      // stacking context (clip-path, transform, …) or floating app chrome
      // above the viewer must not clip or event-occlude the interactive
      // channel panel, size control, or orbit inset.
      root.style.position = "fixed";
    }
  }

  /**
   * The 3D variant mounts into the document body instead of the canvas host:
   * its interactive chrome (channel panel, size control, orbit inset) must
   * stack above app-level floating UI (HUD panels at higher z-index) and must
   * not be trapped by a stacking-context ancestor of the canvas (clip-path,
   * transform, filter). `alignRootToCanvas` pins the root over the canvas in
   * fixed coordinates on every render. The 2D variant stays canvas-local.
   */
  override mount(parent: HTMLElement): void {
    super.mount(this.dimension === "3d" ? parent.ownerDocument.body : parent);
  }

  protected override onMount(root: HTMLDivElement): void {
    const svg = createFullscreenSvg();
    svg.style.pointerEvents = "none";
    const leader = document.createElementNS(SVG_NS, "line");
    leader.style.stroke = "var(--galavi-accent)";
    leader.style.strokeWidth = "1";
    leader.style.strokeLinecap = "square";
    leader.style.vectorEffect = "non-scaling-stroke";
    const source = document.createElementNS(SVG_NS, "rect");
    source.style.fill = "var(--galavi-accent-soft)";
    source.style.stroke = "var(--galavi-accent)";
    source.style.strokeWidth = "1";
    source.style.vectorEffect = "non-scaling-stroke";
    svg.append(leader, source);
    root.appendChild(svg);

    const shell = document.createElement("div");
    shell.style.position = "absolute";
    shell.style.display = "none";
    shell.style.overflow = "hidden";
    shell.style.boxSizing = "border-box";
    shell.style.outline = "1px solid var(--galavi-accent)";
    shell.style.outlineOffset = "-1px";
    shell.style.background = "var(--galavi-panel-bg)";
    shell.style.pointerEvents = this.dimension === "3d" ? "auto" : "none";
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = this.dimension === "3d" ? "auto" : "none";
    shell.appendChild(canvas);

    const loading = document.createElement("div");
    loading.textContent = "REFINING";
    loading.setAttribute("role", "status");
    loading.style.position = "absolute";
    loading.style.top = this.dimension === "3d" ? "35px" : "6px";
    loading.style.right = "7px";
    loading.style.padding = "2px 5px";
    loading.style.background = "var(--galavi-panel-bg)";
    loading.style.color = "var(--galavi-text-dim)";
    loading.style.font = "500 9px var(--galavi-font-mono)";
    loading.style.letterSpacing = "0.08em";
    loading.style.pointerEvents = "none";
    loading.style.display = "none";
    shell.appendChild(loading);
    root.appendChild(shell);

    if (this.dimension === "3d") {
      const sizeControl = this.createSizeControl();
      shell.appendChild(sizeControl);

      const panel = document.createElement("div");
      panel.dataset.magnifierChannelPanel = "";
      panel.style.position = "absolute";
      panel.style.display = "none";
      panel.style.width = `${PANEL_WIDTH}px`;
      panel.style.maxHeight = "100%";
      panel.style.overflow = "auto";
      panel.style.boxSizing = "border-box";
      panel.style.padding = "8px";
      panel.style.border = "1px solid var(--galavi-border)";
      panel.style.background = "linear-gradient(135deg, var(--galavi-accent-soft), transparent 34%), var(--galavi-panel-bg)";
      panel.style.boxShadow = "0 0 18px var(--galavi-accent-soft)";
      panel.style.pointerEvents = "auto";

      const tab = document.createElement("button");
      tab.type = "button";
      tab.style.position = "absolute";
      tab.style.display = "none";
      tab.style.width = `${PANEL_TAB_WIDTH}px`;
      tab.style.height = "76px";
      tab.style.padding = "7px 4px";
      tab.style.border = "1px solid var(--galavi-border)";
      tab.style.background = "linear-gradient(180deg, var(--galavi-accent-soft), transparent), var(--galavi-panel-bg)";
      tab.style.color = "var(--galavi-accent)";
      tab.style.font = "600 9px var(--galavi-font-mono)";
      tab.style.letterSpacing = "0.12em";
      tab.style.writingMode = "vertical-rl";
      tab.style.textTransform = "uppercase";
      tab.style.cursor = "pointer";
      tab.style.pointerEvents = "auto";
      tab.textContent = "Channels";
      tab.addEventListener("click", () => this.setChannelPanelOpen(!this.channelPanelOpen));

      root.appendChild(panel);
      root.appendChild(tab);
      this.channelPanel = panel;
      this.channelTab = tab;
      this.bindInteractionPause(shell);
      this.bindInteractionPause(panel);
    }
    this.shell = shell;
    this.canvasEl = canvas;
    this.source = source;
    this.leader = leader;
    this.loadingEl = loading;
    if (this.dimension === "2d") void this.mountNested(canvas);
  }

  protected override onUnmount(): void {
    this.renderActive = false;
    this.destroyNested();
    this.shell = undefined;
    this.canvasEl = undefined;
    this.source = undefined;
    this.leader = undefined;
    this.loadingEl = undefined;
    this.sizeReadout = undefined;
    this.sizeDecrease = undefined;
    this.sizeIncrease = undefined;
    this.channelPanel = undefined;
    this.channelTab = undefined;
    this.clearPanelListeners();
    this.channelSettings.clear();
    this.panelKey = "";
    this.lastSize = 0;
    this.resetLayoutPreference();
  }

  protected override onOptionsChanged(raw: Record<string, unknown>): void {
    const position = raw.position;
    if (position === null) {
      this.opts.position = null;
      this.renderActive = false;
      this.stopAnimation();
      this.resetLayoutPreference();
    } else if (
      Array.isArray(position) && position.length === 3 &&
      position.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      this.opts.position = [...position] as Vec3;
    }
    if (typeof raw.zoom === "number" && Number.isFinite(raw.zoom) && raw.zoom > 0) {
      this.opts.zoom = Math.max(1, raw.zoom);
    }
    if (typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size > 0) this.opts.size = raw.size;
    if (typeof raw.voxelExtent3d === "number" && Number.isFinite(raw.voxelExtent3d) && raw.voxelExtent3d >= 1) {
      this.opts.voxelExtent3d = nearestVoxelExtent(raw.voxelExtent3d);
      this.syncSizeControl();
    }
    if ("layers" in raw) {
      const layers = raw.layers === undefined
        ? undefined
        : Array.isArray(raw.layers) && raw.layers.every((id) => typeof id === "string")
          ? [...raw.layers] as string[]
          : this.opts.layers;
      if (!arraysEqual(layers, this.opts.layers)) {
        this.opts.layers = layers;
        this.destroyNested();
      }
    }
    if (raw.visible === false) {
      this.opts.position = null;
      this.renderActive = false;
      this.clearPanelListeners();
      this.channelPanel?.replaceChildren();
      if (this.channelTab) this.channelTab.style.display = "none";
      this.channelSettings.clear();
      this.panelKey = "";
      this.destroyNested();
      this.resetLayoutPreference();
    }
  }

  protected override onHidden(): void {
    this.renderActive = false;
    this.stopAnimation();
    this.resetLayoutPreference();
  }

  protected override onRender(state: State): void {
    if (!this.root || !this.shell || !this.source || !this.leader) return;
    const position = this.opts.position;
    const canvas = this.getCanvas();
    if (!position || !canvas) return this.hideArtifacts();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return this.hideArtifacts();
    this.alignRootToCanvas(canvas, width, height);

    if (this.dimension === "2d") {
      this.render2d(state, width, height);
      return;
    }

    this.render3d(state, width, height);
  }

  private render2d(state: State, width: number, height: number): void {
    const position = this.opts.position!;
    const axisMap = this.getAxisMap();
    const screen = axisMap
      ? physicalToSliceScreen(position, state, axisMap, width, height)
      : physicalToVolumeScreen(position, state.exploration.camera, width, height);
    if (!screen) return this.hideArtifacts();

    const bounds = projectedImageBounds(state, axisMap, width, height);
    if (
      screen[0] < bounds.left || screen[0] > bounds.right ||
      screen[1] < bounds.top || screen[1] > bounds.bottom
    ) return this.hideArtifacts();

    const insetSize = this.resolveOverlaySize(bounds);
    const sourceSize = Math.min(
      insetSize / Math.max(1, this.opts.zoom),
      insetSize,
      rectWidth(bounds),
      rectHeight(bounds),
    );
    const source = makeRect(
      clamp(screen[0] - sourceSize / 2, bounds.left, bounds.right - sourceSize),
      clamp(screen[1] - sourceSize / 2, bounds.top, bounds.bottom - sourceSize),
      sourceSize,
    );
    const layout = layoutMagnifier(
      source,
      bounds,
      insetSize,
      0,
      this.lastPlacement,
      this.lastConnectorCorners,
    );
    this.viewportHeight = height;
    this.paintLayout(layout, insetSize);
    this.renderActive = true;
    if (!this.nested && this.canvasEl) void this.mountNested(this.canvasEl);
    this.syncNested2d(state);
  }

  private render3d(state: State, width: number, height: number): void {
    const prepared = this.prepare3d(state);
    if (!prepared) return this.hideArtifacts();
    const axisMap = this.getAxisMap();
    const sourceRect = projectedRect(prepared.reference.corners, state, axisMap, width, height);
    if (!sourceRect) return this.hideArtifacts();
    const bounds = projectedImageBounds(state, axisMap, width, height);
    if (
      sourceRect.right < bounds.left || sourceRect.left > bounds.right ||
      sourceRect.bottom < bounds.top || sourceRect.top > bounds.bottom
    ) return this.hideArtifacts();

    const insetSize = this.resolveOverlaySize(bounds);
    const layout = layoutMagnifier(
      sourceRect,
      bounds,
      insetSize,
      PANEL_TAB_WIDTH + (this.channelPanelOpen ? PANEL_WIDTH : 0),
      this.lastPlacement,
      this.lastConnectorCorners,
    );
    this.paintLayout(layout, insetSize);
    this.positionChannelPanel(layout);
    this.renderActive = true;
    if (!this.nested && this.canvasEl) void this.mountNested(this.canvasEl);
    this.syncNested3d(state, prepared);
    this.ensureAnimation();
  }

  private paintLayout(layout: MagnifierLayout, insetSize: number): void {
    if (!this.root || !this.shell || !this.source || !this.leader) return;
    this.lastPlacement = layout.placement;
    this.lastConnectorCorners = layout.connectorCorners;
    if (insetSize !== this.lastSize) {
      this.lastSize = insetSize;
      this.shell.style.width = `${insetSize}px`;
      this.shell.style.height = `${insetSize}px`;
      this.nested?.requestRender();
    }
    this.root.style.display = "block";
    this.shell.style.display = "block";
    this.shell.style.left = `${layout.inset.left}px`;
    this.shell.style.top = `${layout.inset.top}px`;
    this.source.setAttribute("x", `${layout.source.left}`);
    this.source.setAttribute("y", `${layout.source.top}`);
    this.source.setAttribute("width", `${rectWidth(layout.source)}`);
    this.source.setAttribute("height", `${rectHeight(layout.source)}`);
    this.leader.setAttribute("x1", `${layout.connector.from.x}`);
    this.leader.setAttribute("y1", `${layout.connector.from.y}`);
    this.leader.setAttribute("x2", `${layout.connector.to.x}`);
    this.leader.setAttribute("y2", `${layout.connector.to.y}`);
  }

  private prepare3d(state: State): PreparedMagnifier | undefined {
    const position = this.opts.position;
    if (!position) return undefined;
    const ids = new Set(this.opts.layers ?? this.getLayerIds());
    const selected: PreparedLayer[] = [];
    const wrappedById = new Map<string, LayerConfig>();
    for (const desc of state.layers) {
      const pyramid = desc.data?.pyramid;
      if (!ids.has(desc.id) || !pyramid?.levels.length || !desc.data?.fetch) continue;
      if (desc.type !== "slice" && desc.type !== "volume") continue;
      const model = layerModelMatrix(desc, state.physical);
      let region: MagnifierRegion;
      try {
        region = computeMagnifierVoxelRegion({
          pyramid,
          model,
          position,
          voxelExtent: this.opts.voxelExtent3d,
        });
      } catch {
        continue;
      }
      const setting = this.ensureChannelSetting(desc, state);
      const wrapped: LayerConfig = {
        ...desc,
        type: "volume",
        options: {
          ...(desc.options ?? {}),
          region: region.normalizedBounds,
          finestLevel: true,
        },
        render: {
          ...(desc.render ?? {}),
          volumeProjection: "mip",
          visible: setting.visible,
          contrastLimits: [...setting.contrast],
          color: setting.color,
        },
      };
      const prepared: PreparedLayer = {
        id: desc.id,
        source: desc,
        wrapped,
        region,
        corners: regionCorners(model, region),
      };
      selected.push(prepared);
      wrappedById.set(desc.id, wrapped);
    }
    if (selected.length === 0) return undefined;
    const selectedIds = selected.map((layer) => layer.id);
    const liveIds = new Set(selectedIds);
    for (const id of this.channelSettings.keys()) {
      if (!liveIds.has(id)) this.channelSettings.delete(id);
    }
    return {
      selected,
      reference: selected[0],
      selectedIds,
      layers: state.layers.map((desc) => wrappedById.get(desc.id) ?? desc),
    };
  }

  private async mountNested(canvas: HTMLCanvasElement): Promise<void> {
    if (this.nestedMounting) return;
    const owner = this.getOwner();
    const viewType = this.dimension === "3d" ? "volume" : this.getViewType();
    if (!owner || !viewType) return;
    const initial = owner.getState();
    const prepared = this.dimension === "3d" ? this.prepare3d(initial) : undefined;
    const selectedIds = prepared?.selectedIds ?? [...(this.opts.layers ?? this.getLayerIds())];
    if (selectedIds.length === 0 || (this.dimension === "3d" && !prepared)) return;

    this.nestedMounting = true;
    const token = ++this.mountToken;
    try {
      const nestedState: State = prepared ? { ...initial, layers: prepared.layers } : initial;
      if (prepared) this.seedCamera3d(nestedState, prepared.reference);
      else this.applyCamera2d(nestedState);
      let instance: ViewerEngine;
      try {
        // Lazy: a static value import would close a module cycle
        // (registry → magnifier → viewer → dataset → registry), risking
        // partially-initialized module bindings. `../viewer` is already in
        // the main chunk via the package entry, so this adds no split chunk.
        const { createViewerEngine } = await import("../viewer");
        instance = await createViewerEngine({
          state: nestedState,
          theme: owner.theme,
          views: {
            magnifier: {
              type: viewType,
              canvas,
              layers: selectedIds,
              activatable: this.dimension === "3d",
              ...(this.dimension === "3d" ? { controls: { orbit: {} } } : {}),
            },
          },
        });
      } catch (error) {
        console.warn("[MagnifierOverlay] nested view init failed:", error);
        return;
      }
      if (token !== this.mountToken) {
        instance.destroy();
        return;
      }
      this.nested = instance;
      this.mountedLayerIds = selectedIds;
      this.lastFollowKey = "";
      this.lastLayers = undefined;
      const latest = owner.getState();
      if (prepared) {
        instance.setActiveView("magnifier");
        this.rebuildChannelPanel(initial, prepared);
        this.syncNested3d(latest, this.prepare3d(latest) ?? prepared);
        this.ensureAnimation();
      } else {
        this.syncNested2d(latest);
      }
    } finally {
      this.nestedMounting = false;
    }
  }

  private syncNested2d(state: State): void {
    const nested = this.nested;
    const position = this.opts.position;
    if (!nested || !position) return;
    const selectedIds = [...(this.opts.layers ?? this.getLayerIds())];
    if (!arraysEqual(selectedIds, this.mountedLayerIds)) {
      this.destroyNested();
      if (this.canvasEl) void this.mountNested(this.canvasEl);
      return;
    }
    const camera = state.exploration.camera;
    const key = [
      ...position,
      ...camera.position,
      ...camera.target,
      this.opts.zoom,
      this.lastSize,
      this.viewportHeight,
    ].join(",");
    const layersChanged = state.layers !== this.lastLayers;
    if (key === this.lastFollowKey && !layersChanged) return;

    const next = nested.getState();
    if (layersChanged) next.layers = state.layers;
    this.applyCamera2d(next, camera);
    nested.setState(next);
    this.lastFollowKey = key;
    this.lastLayers = state.layers;
  }

  private syncNested3d(state: State, prepared: PreparedMagnifier): void {
    const nested = this.nested;
    if (!nested) return;
    if (!arraysEqual(prepared.selectedIds, this.mountedLayerIds)) {
      this.destroyNested();
      if (this.canvasEl) void this.mountNested(this.canvasEl);
      return;
    }
    const position = this.opts.position!;
    const key = [
      position[0], position[1], position[2],
      this.opts.voxelExtent3d,
    ].join(",");
    const layersChanged = state.layers !== this.lastLayers;
    if (key === this.lastFollowKey && !layersChanged) {
      this.updateLoadingState(prepared.selectedIds);
      return;
    }
    const next = nested.getState();
    next.layers = prepared.layers;
    this.applyCamera3d(next, prepared.reference);
    nested.setState(next);
    this.lastFollowKey = key;
    this.lastLayers = state.layers;
    this.rebuildChannelPanel(state, prepared);
    this.updateLoadingState(prepared.selectedIds);
  }

  private seedCamera3d(state: State, reference: PreparedLayer): void {
    if (this.getViewType() !== "volume") {
      const camera = state.exploration.camera;
      const length = Math.hypot(...DEFAULT_VIEW_OFFSET);
      const distance = Math.max(cameraDistance(camera), 1);
      camera.target = [...reference.region.worldCenter];
      camera.position = [
        camera.target[0] + DEFAULT_VIEW_OFFSET[0] / length * distance,
        camera.target[1] + DEFAULT_VIEW_OFFSET[1] / length * distance,
        camera.target[2] + DEFAULT_VIEW_OFFSET[2] / length * distance,
      ];
    }
    this.applyCamera3d(state, reference);
  }

  private applyCamera2d(
    state: State,
    sourceCamera = state.exploration.camera,
  ): void {
    const position = this.opts.position;
    if (!position) return;
    const scale = this.lastSize > 0 && this.viewportHeight > 0
      ? this.lastSize / this.viewportHeight / Math.max(1, this.opts.zoom)
      : 1 / Math.max(1, this.opts.zoom);
    state.exploration.camera = {
      ...sourceCamera,
      target: [...position],
      position: [
        position[0] + (sourceCamera.position[0] - sourceCamera.target[0]) * scale,
        position[1] + (sourceCamera.position[1] - sourceCamera.target[1]) * scale,
        position[2] + (sourceCamera.position[2] - sourceCamera.target[2]) * scale,
      ],
    };
  }

  private applyCamera3d(state: State, reference: PreparedLayer): void {
    const target = reference.region.worldCenter;
    const camera = state.exploration.camera;
    let offset: Vec3 = [
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    ];
    let length = Math.hypot(...offset);
    if (length < 1e-12) {
      offset = [...DEFAULT_VIEW_OFFSET];
      length = Math.hypot(...offset);
    }
    const radius = Math.max(
      ...reference.corners.map((corner) => Math.hypot(corner[0] - target[0], corner[1] - target[1], corner[2] - target[2])),
      Number.EPSILON,
    );
    const distance = radius / Math.sin(DEFAULT_FOV / 2) * BLOCK_FRAME_MARGIN;
    state.exploration.camera = {
      navMode: "orbit",
      projMode: "perspective",
      target: [...target],
      position: [
        target[0] + offset[0] / length * distance,
        target[1] + offset[1] / length * distance,
        target[2] + offset[2] / length * distance,
      ],
    };
  }

  private ensureChannelSetting(desc: LayerConfig, state: State): ChannelSetting {
    const existing = this.channelSettings.get(desc.id);
    if (existing) return existing;
    const selection = desc.options?.selection;
    const channel = selection && typeof selection === "object" ? (selection as Record<string, unknown>).c : undefined;
    const channelName = typeof channel === "number" ? state.physical?.channels?.names[channel] : undefined;
    const setting: ChannelSetting = {
      visible: desc.render?.visible ?? true,
      contrast: [...(desc.render?.contrastLimits ?? [0, 1])],
      color: desc.render?.color,
      label: channelName ?? desc.id,
    };
    this.channelSettings.set(desc.id, setting);
    return setting;
  }

  private rebuildChannelPanel(state: State, prepared: PreparedMagnifier): void {
    const panel = this.channelPanel;
    if (!panel || this.dimension !== "3d") return;
    const key = prepared.selected.map((layer) => `${layer.id}:${this.ensureChannelSetting(layer.source, state).label}`).join("|");
    if (key === this.panelKey) return;
    this.panelKey = key;
    this.clearPanelListeners();
    panel.replaceChildren();
    for (const layer of prepared.selected) {
      const setting = this.ensureChannelSetting(layer.source, state);
      const row = document.createElement("div");
      row.dataset.magnifierChannel = layer.id;
      row.style.display = "flex";
      row.style.flexDirection = "column";
      row.style.gap = "8px";
      row.style.padding = "4px 0 8px";
      row.style.borderBottom = "1px solid var(--galavi-border)";

      const heading = document.createElement("div");
      heading.style.display = "flex";
      heading.style.alignItems = "center";
      heading.style.gap = "8px";

      const visible = document.createElement("button");
      visible.type = "button";
      visible.style.display = "inline-flex";
      visible.style.width = "27px";
      visible.style.height = "27px";
      visible.style.flex = "0 0 auto";
      visible.style.alignItems = "center";
      visible.style.justifyContent = "center";
      visible.style.padding = "0";
      visible.style.border = "1px solid var(--galavi-border)";
      visible.style.background = "transparent";
      visible.style.cursor = "pointer";

      const swatch = document.createElement("span");
      swatch.style.width = "27px";
      swatch.style.height = "27px";
      swatch.style.flex = "0 0 auto";
      swatch.style.boxSizing = "border-box";
      swatch.style.padding = "2px";
      swatch.style.background = setting.color ?? "var(--galavi-text)";
      swatch.style.border = "1px solid var(--galavi-border)";

      const label = document.createElement("span");
      label.textContent = setting.label;
      label.style.minWidth = "0";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      label.style.whiteSpace = "nowrap";
      label.style.color = "var(--galavi-text)";
      label.style.font = "500 10px var(--galavi-font-mono)";

      const renderVisibility = () => {
        visible.setAttribute("aria-label", `${setting.visible ? "Hide" : "Show"} ${setting.label}`);
        visible.setAttribute("aria-pressed", String(setting.visible));
        visible.style.borderColor = setting.visible ? "var(--galavi-accent)" : "var(--galavi-border)";
        visible.style.background = setting.visible ? "var(--galavi-accent-soft)" : "transparent";
        visible.style.color = setting.visible ? "var(--galavi-accent)" : "var(--galavi-text-dim)";
        visible.innerHTML = setting.visible
          ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>'
          : '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M3 3l10 10"/><path d="M6.5 4.1A6.9 6.9 0 0 1 8 4c4.1 0 6.5 4 6.5 4a12.7 12.7 0 0 1-2.2 2.7M4.1 5.3A12.4 12.4 0 0 0 1.5 8s2.4 4 6.5 4a6.7 6.7 0 0 0 2.6-.5"/></svg>';
      };
      renderVisibility();
      visible.addEventListener("click", () => {
        setting.visible = !setting.visible;
        renderVisibility();
        this.applyLocalChannel(layer.id, setting);
      });

      heading.append(visible, swatch, label);
      const dualRange = this.createDualRange(setting, (contrast) => {
        setting.contrast = contrast;
        this.applyLocalChannel(layer.id, setting);
      });
      this.panelCleanup.push(dualRange.destroy);
      row.append(heading, dualRange.root);
      panel.appendChild(row);
    }
  }

  private createDualRange(
    setting: ChannelSetting,
    onChange: (value: [number, number]) => void,
  ): { root: HTMLElement; destroy: () => void } {
    let value: [number, number] = [...setting.contrast];
    const root = document.createElement("div");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.gap = "7px";
    root.style.minWidth = "0";
    root.style.padding = "0 6px";

    const slider = document.createElement("div");
    slider.className = "range-slider";
    slider.style.position = "relative";
    slider.style.width = "100%";
    slider.style.height = "24px";
    slider.style.cursor = "pointer";

    const rail = document.createElement("div");
    rail.style.position = "absolute";
    rail.style.top = "50%";
    rail.style.left = "0";
    rail.style.right = "0";
    rail.style.height = "2px";
    rail.style.background = "var(--galavi-border)";
    rail.style.transform = "translateY(-50%)";
    const fill = document.createElement("div");
    fill.style.position = "absolute";
    fill.style.top = "50%";
    fill.style.height = "2px";
    fill.style.background = "var(--galavi-accent)";
    fill.style.boxShadow = "0 0 6px var(--galavi-accent-soft)";
    fill.style.transform = "translateY(-50%)";

    const minThumb = this.createRangeThumb(`${setting.label} minimum`);
    const maxThumb = this.createRangeThumb(`${setting.label} maximum`);
    const readout = document.createElement("span");
    readout.style.color = "var(--galavi-text-dim)";
    readout.style.font = "var(--galavi-font-size) var(--galavi-font-mono)";
    readout.style.fontVariantNumeric = "tabular-nums";
    readout.style.whiteSpace = "nowrap";

    const epsilon = 0.001;
    const toPercent = (next: number): number => {
      const numerator = Math.log(Math.max(0, Math.min(1, next)) + epsilon) - Math.log(epsilon);
      const denominator = Math.log(1 + epsilon) - Math.log(epsilon);
      return denominator > 0 ? numerator / denominator * 100 : 0;
    };
    const fromPercent = (percent: number): number => {
      const ratio = Math.max(0, Math.min(1, percent / 100));
      const next = Math.exp(Math.log(epsilon) + ratio * (Math.log(1 + epsilon) - Math.log(epsilon))) - epsilon;
      return Math.max(0, Math.min(1, Math.round(next * 1000) / 1000));
    };
    const render = () => {
      const start = toPercent(value[0]);
      const end = toPercent(value[1]);
      minThumb.style.left = `${start}%`;
      maxThumb.style.left = `${end}%`;
      fill.style.left = `${start}%`;
      fill.style.right = `${100 - end}%`;
      readout.textContent = `${value[0].toFixed(3)} - ${value[1].toFixed(3)}`;
    };
    const valueFromMouse = (event: MouseEvent): number => {
      const bounds = slider.getBoundingClientRect();
      if (bounds.width <= 0) return value[0];
      return fromPercent((event.clientX - bounds.left) / bounds.width * 100);
    };
    let stopDrag: (() => void) | undefined;
    const teardown = () => {
      stopDrag?.();
      stopDrag = undefined;
    };
    const setThumb = (which: "min" | "max", next: number) => {
      value = which === "min"
        ? [Math.min(next, value[1]), value[1]]
        : [value[0], Math.max(next, value[0])];
      render();
      onChange([...value]);
    };
    const startDrag = (which: "min" | "max", event: MouseEvent) => {
      teardown();
      const onMove = (nextEvent: MouseEvent) => setThumb(which, valueFromMouse(nextEvent));
      const onUp = () => teardown();
      stopDrag = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      onMove(event);
    };
    minThumb.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startDrag("min", event);
    });
    maxThumb.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startDrag("max", event);
    });
    slider.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const next = valueFromMouse(event);
      startDrag(Math.abs(next - value[0]) <= Math.abs(next - value[1]) ? "min" : "max", event);
    });

    slider.append(rail, fill, minThumb, maxThumb);
    root.append(slider, readout);
    render();
    return { root, destroy: teardown };
  }

  private createRangeThumb(label: string): HTMLButtonElement {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "range-thumb";
    thumb.setAttribute("aria-label", label);
    thumb.style.position = "absolute";
    thumb.style.top = "50%";
    thumb.style.width = "10px";
    thumb.style.height = "12px";
    thumb.style.padding = "0";
    thumb.style.border = "1px solid var(--galavi-accent)";
    thumb.style.borderRadius = "1px";
    thumb.style.background = "var(--galavi-panel-bg)";
    thumb.style.boxShadow = "0 0 6px var(--galavi-accent-soft)";
    thumb.style.transform = "translate(-50%, -50%)";
    thumb.style.cursor = "pointer";
    return thumb;
  }

  private clearPanelListeners(): void {
    for (const cleanup of this.panelCleanup) cleanup();
    this.panelCleanup = [];
  }

  private applyLocalChannel(id: string, setting: ChannelSetting): void {
    this.nested?.layer(id)?.setRender({ visible: setting.visible, contrastLimits: [...setting.contrast] });
    this.ensureAnimation();
  }

  private positionChannelPanel(layout: MagnifierLayout): void {
    const panel = this.channelPanel;
    const tab = this.channelTab;
    if (!panel || !tab) return;
    tab.style.display = "flex";
    tab.style.alignItems = "center";
    tab.style.justifyContent = "center";
    tab.style.top = `${layout.inset.top}px`;
    tab.style.left = layout.panelSide === "right"
      ? `${layout.inset.right}px`
      : `${layout.inset.left - PANEL_TAB_WIDTH}px`;
    tab.style.borderLeft = layout.panelSide === "right" ? "0" : "1px solid var(--galavi-border)";
    tab.style.borderRight = layout.panelSide === "left" ? "0" : "1px solid var(--galavi-border)";
    tab.setAttribute("aria-label", `${this.channelPanelOpen ? "Collapse" : "Expand"} channels`);
    tab.setAttribute("aria-expanded", String(this.channelPanelOpen));

    panel.style.display = this.channelPanelOpen ? "block" : "none";
    panel.style.top = `${layout.inset.top}px`;
    panel.style.left = layout.panelSide === "right"
      ? `${layout.inset.right + PANEL_TAB_WIDTH}px`
      : `${layout.inset.left - PANEL_TAB_WIDTH - PANEL_WIDTH}px`;
  }

  private setChannelPanelOpen(open: boolean): void {
    this.channelPanelOpen = open;
    if (this.channelPanel) this.channelPanel.style.display = open ? "block" : "none";
    if (this.channelTab) {
      this.channelTab.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} channels`);
      this.channelTab.setAttribute("aria-expanded", String(open));
    }
    this.getOwner()?.requestRender();
  }

  private createSizeControl(): HTMLDivElement {
    const control = document.createElement("div");
    control.style.position = "absolute";
    control.style.zIndex = "3";
    control.style.top = "6px";
    control.style.right = "7px";
    control.style.display = "grid";
    control.style.gridTemplateColumns = "auto 18px auto 18px";
    control.style.gap = "4px";
    control.style.alignItems = "center";
    control.style.padding = "3px 4px";
    control.style.border = "1px solid var(--galavi-border)";
    control.style.background = "var(--galavi-panel-bg)";
    control.style.color = "var(--galavi-text-dim)";
    control.style.font = "600 9px var(--galavi-font-mono)";
    control.style.letterSpacing = "0.08em";
    control.style.pointerEvents = "auto";

    const label = document.createElement("span");
    label.textContent = "Size";
    label.style.textTransform = "uppercase";
    const decrease = this.createSizeButton("−", "Decrease 3D block size", -1);
    const readout = document.createElement("span");
    readout.dataset.magnifierSize = "";
    readout.style.minWidth = "34px";
    readout.style.color = "var(--galavi-text)";
    readout.style.textAlign = "center";
    const increase = this.createSizeButton("+", "Increase 3D block size", 1);
    control.append(label, decrease, readout, increase);
    this.sizeReadout = readout;
    this.sizeDecrease = decrease;
    this.sizeIncrease = increase;
    this.syncSizeControl();
    return control;
  }

  private createSizeButton(label: string, ariaLabel: string, delta: -1 | 1): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.style.width = "18px";
    button.style.height = "18px";
    button.style.padding = "0";
    button.style.border = "1px solid var(--galavi-border)";
    button.style.background = "transparent";
    button.style.color = "var(--galavi-accent)";
    button.style.cursor = "pointer";
    button.addEventListener("click", () => this.stepVoxelExtent(delta));
    return button;
  }

  private stepVoxelExtent(delta: -1 | 1): void {
    const index = VOXEL_EXTENT_STEPS.indexOf(this.opts.voxelExtent3d as 16 | 32 | 64);
    const nextIndex = Math.max(0, Math.min(VOXEL_EXTENT_STEPS.length - 1, index + delta));
    const next = VOXEL_EXTENT_STEPS[nextIndex];
    if (next === this.opts.voxelExtent3d) return;
    this.opts.voxelExtent3d = next;
    this.lastFollowKey = "";
    if (this.loadingEl) this.loadingEl.style.display = "block";
    this.syncSizeControl();
    this.getOwner()?.requestRender();
  }

  private syncSizeControl(): void {
    const index = VOXEL_EXTENT_STEPS.indexOf(this.opts.voxelExtent3d as 16 | 32 | 64);
    if (this.sizeReadout) this.sizeReadout.textContent = `${this.opts.voxelExtent3d} vx`;
    if (this.sizeDecrease) this.sizeDecrease.disabled = index <= 0;
    if (this.sizeIncrease) this.sizeIncrease.disabled = index >= VOXEL_EXTENT_STEPS.length - 1;
  }

  private bindInteractionPause(element: HTMLElement): void {
    element.addEventListener("pointerdown", () => this.pauseSpin());
    for (const event of ["pointerup", "pointercancel", "pointerleave", "wheel"] as const) {
      element.addEventListener(event, () => this.scheduleSpinResume());
    }
  }

  private pauseSpin(): void {
    if (this.dimension !== "3d") return;
    this.spinPaused = true;
    if (this.spinResumeTimer !== undefined) clearTimeout(this.spinResumeTimer);
    this.spinResumeTimer = undefined;
  }

  private scheduleSpinResume(): void {
    if (this.dimension !== "3d") return;
    this.pauseSpin();
    this.spinResumeTimer = window.setTimeout(() => {
      this.spinPaused = false;
      this.spinLastTs = performance.now();
      this.ensureAnimation();
    }, SPIN_RESUME_DELAY_MS);
  }

  private ensureAnimation(): void {
    if (this.animationFrameId !== undefined || !this.renderActive || !this.nested) return;
    this.spinLastTs = performance.now();
    const tick = (timestamp: number) => {
      this.animationFrameId = undefined;
      const nested = this.nested;
      if (!nested || !this.renderActive) return;
      if (this.dimension === "3d" && !this.spinPaused) {
        const elapsed = Math.min(Math.max(timestamp - this.spinLastTs, 0) / 1000, 0.1);
        if (elapsed > 0) {
          const state = nested.getState();
          const camera = state.exploration.camera;
          const distance = cameraDistance(camera);
          const { yaw, pitch } = cameraAngles(camera);
          camera.position = computePosition(camera.target, distance, yaw + SPIN_SPEED_DEG_PER_SEC * Math.PI / 180 * elapsed, pitch);
          nested.setState(state);
        }
      }
      this.spinLastTs = timestamp;
      const refining = this.updateLoadingState(this.mountedLayerIds);
      if (this.dimension === "3d" || refining) this.animationFrameId = requestAnimationFrame(tick);
    };
    this.animationFrameId = requestAnimationFrame(tick);
  }

  private updateLoadingState(ids: readonly string[]): boolean {
    const loading = this.loadingEl;
    const nested = this.nested;
    if (!loading || !nested) return false;
    const visibleIds = ids.filter((id) => this.dimension !== "3d" || this.channelSettings.get(id)?.visible !== false);
    const refining = visibleIds.some((id) => {
      const resolution = nested.view("magnifier").getResolution(id);
      return !resolution || resolution.refining || resolution.targetLevel !== 0;
    });
    loading.style.display = refining ? "block" : "none";
    return refining;
  }

  private stopAnimation(): void {
    if (this.animationFrameId !== undefined) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = undefined;
    if (this.spinResumeTimer !== undefined) clearTimeout(this.spinResumeTimer);
    this.spinResumeTimer = undefined;
  }

  private destroyNested(): void {
    this.mountToken++;
    const nested = this.nested;
    this.nested = undefined;
    nested?.destroy();
    this.nestedMounting = false;
    this.mountedLayerIds = [];
    this.lastFollowKey = "";
    this.lastLayers = undefined;
    this.stopAnimation();
  }

  private hideArtifacts(): void {
    this.renderActive = false;
    this.stopAnimation();
    if (this.root) this.root.style.display = "none";
    if (this.shell) this.shell.style.display = "none";
    if (this.channelPanel) this.channelPanel.style.display = "none";
    if (this.channelTab) this.channelTab.style.display = "none";
  }

  private alignRootToCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
    if (!this.root) return;
    const canvasRect = canvas.getBoundingClientRect();
    const hasLayout = canvasRect.width > 0 || canvasRect.height > 0;
    if (this.dimension === "3d") {
      // Fixed, body-mounted root: pin directly over the canvas in viewport
      // coordinates (recomputed every render, so scroll/resize track).
      this.root.style.left = `${hasLayout ? canvasRect.left : canvas.offsetLeft}px`;
      this.root.style.top = `${hasLayout ? canvasRect.top : canvas.offsetTop}px`;
    } else {
      const hostRect = this.getHostElement()?.getBoundingClientRect();
      const left = hostRect && hasLayout ? canvasRect.left - hostRect.left : canvas.offsetLeft;
      const top = hostRect && hasLayout ? canvasRect.top - hostRect.top : canvas.offsetTop;
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    }
    this.root.style.width = `${width}px`;
    this.root.style.height = `${height}px`;
  }

  private resolveOverlaySize(bounds: ScreenRect): number {
    const available = Math.max(1, Math.floor(Math.min(rectWidth(bounds), rectHeight(bounds))));
    if (this.opts.size !== undefined) return Math.min(this.opts.size, available);
    const hostWidth = this.getHostElement()?.clientWidth ?? 0;
    const desired = Math.round(Math.max(AUTO_SIZE_MIN, Math.min(AUTO_SIZE_MAX, hostWidth / 4)));
    return Math.min(desired, available);
  }

  private resetLayoutPreference(): void {
    this.lastPlacement = undefined;
    this.lastConnectorCorners = undefined;
  }
}