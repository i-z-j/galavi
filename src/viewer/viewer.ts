/**
 * Viewer — the high-level facade over the low-level Galavi scene API
 * (DX-L1 facade, DX-L2 mode transitions, DX-M3 channel model, DX-M6
 * control/tool runtime parity).
 *
 * The Viewer OWNS one dataset session and translates the minimal
 * `ViewerConfig` schema into the existing low-level scene model
 * (engineering-cleanup-plan.md §15.5): one typed volume/slice layer per
 * channel with nested `options.selection.c`, one view per mode, cameras via
 * the existing fit helpers, controls/tools via the existing control/overlay
 * registries. Nothing here forks the scene model — `createGalavi`, layer
 * configs, and view configs do the work; `viewer.galavi` is the explicit
 * escape hatch for advanced composition.
 *
 * Async discipline (DX-M2/DX-L2): `open()` and mode transitions are
 * last-write-wins. Every operation carries a revision token; a superseded
 * operation never clobbers newer state and rejects with
 * {@link ViewerSupersededError}. `viewer.ready` settles with the latest
 * operation; `viewer.status` tracks idle/loading/ready/error.
 */

import { createGalavi, Galavi } from "../main";
import { openDataset, type ResolvedDataset } from "../dataset";
import { controlRegistry, overlayRegistry } from "../registry";
import type {
  Camera,
  ControlOptions,
  GalaviConfig,
  LayerConfig,
  OverlayOptions,
  PhysicalSpace,
  Render,
  SourceDescriptor,
  Vec3,
  ViewConfig,
} from "../types";
import type { BaseControl } from "../control";
import type { BaseOverlay } from "../overlay";
import {
  clampContrastLimits,
  fitSliceCamera,
  frameVolumeCamera,
  normalizeHexColor,
  resolveAxes,
} from "../utils";
import type {
  ResolvedViewerMode,
  ViewerCamera,
  ViewerChannelAccessor,
  ViewerChannelConfig,
  ViewerChannelPatch,
  ViewerChannelState,
  ViewerConfig,
  ViewerControlAccessor,
  ViewerControlName,
  ViewerControlOptionsMap,
  ViewerControlsConfig,
  ViewerMagnifierOptions,
  ViewerMode,
  ViewerModeOverride,
  ViewerModeOverrides,
  ViewerProjection,
  ViewerStatus,
  ViewerToolAccessor,
  ViewerToolName,
  ViewerToolOptionsMap,
  ViewerToolsConfig,
  ViewerViewAccessor,
} from "./types";

// ============================================================================
// ERRORS + VALIDATION
// ============================================================================

/** Rejection reason for an `open()`/mode transition superseded by a newer call. */
export class ViewerSupersededError extends Error {
  constructor(operation: string) {
    super(`${operation} superseded by a newer call — the latest call wins`);
    this.name = "ViewerSupersededError";
  }
}

const VIEWER_MODES: readonly ViewerMode[] = ["auto", "slice", "volume", "quad"];
const RESOLVED_MODES: readonly ResolvedViewerMode[] = ["slice", "volume", "quad"];
const PROJECTIONS: readonly ViewerProjection[] = ["mip", "minip", "mean"];
const CONTROL_NAMES: readonly ViewerControlName[] = ["orbit", "fly", "panzoom"];
const TOOL_NAMES: readonly ViewerToolName[] = ["crosshair", "ruler", "magnifier", "roi"];

function assertViewerMode(value: unknown): asserts value is ViewerMode {
  if (!VIEWER_MODES.includes(value as ViewerMode)) {
    throw new Error(`Invalid viewer mode: ${JSON.stringify(value)} (expected one of: ${VIEWER_MODES.join(", ")})`);
  }
}

function assertResolvedMode(value: unknown): asserts value is ResolvedViewerMode {
  if (!RESOLVED_MODES.includes(value as ResolvedViewerMode)) {
    throw new Error(`Invalid mode: ${JSON.stringify(value)} (expected one of: ${RESOLVED_MODES.join(", ")} — "auto" is not a mode entry)`);
  }
}

function assertProjection(value: unknown): asserts value is ViewerProjection {
  if (!PROJECTIONS.includes(value as ViewerProjection)) {
    throw new Error(`Invalid projection: ${JSON.stringify(value)} (expected one of: ${PROJECTIONS.join(", ")})`);
  }
}

function assertControlName(value: unknown): asserts value is ViewerControlName {
  if (!CONTROL_NAMES.includes(value as ViewerControlName)) {
    throw new Error(`Unknown control: ${JSON.stringify(value)} (expected one of: ${CONTROL_NAMES.join(", ")})`);
  }
}

function assertToolName(value: unknown): asserts value is ViewerToolName {
  if (!TOOL_NAMES.includes(value as ViewerToolName)) {
    throw new Error(`Unknown tool: ${JSON.stringify(value)} (expected one of: ${TOOL_NAMES.join(", ")})`);
  }
}

// ============================================================================
// NORMALIZATION (shared by the declarative and imperative paths — §15.4)
// ============================================================================

/**
 * Validate and normalize one channel patch. Used identically for config
 * `channels[n]`, `modeOverrides` channel entries, and
 * `viewer.channel(index).configure`: colors normalize to `#RRGGBB` (malformed
 * throws), contrast clamps into [0, 1] ordered low ≤ high.
 */
function normalizeChannelPatch(patch: ViewerChannelPatch, context: string): ViewerChannelPatch {
  if (patch === null || typeof patch !== "object") {
    throw new Error(`${context}: channel config must be an object, got ${JSON.stringify(patch)}`);
  }
  const out: ViewerChannelPatch = {};
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string") {
      throw new Error(`${context}: label must be a string, got ${JSON.stringify(patch.label)}`);
    }
    out.label = patch.label;
  }
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== "boolean") {
      throw new Error(`${context}: visible must be a boolean, got ${JSON.stringify(patch.visible)}`);
    }
    out.visible = patch.visible;
  }
  if (patch.color !== undefined) {
    const color = normalizeHexColor(typeof patch.color === "string" ? patch.color : undefined);
    if (!color) {
      throw new Error(`${context}: invalid color ${JSON.stringify(patch.color)} (expected #RRGGBB)`);
    }
    out.color = color;
  }
  if (patch.contrast !== undefined) {
    const c = patch.contrast;
    if (!Array.isArray(c) || c.length !== 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      throw new Error(`${context}: contrast must be a [min, max] number pair, got ${JSON.stringify(c)}`);
    }
    out.contrast = clampContrastLimits([c[0], c[1]]) as [number, number];
  }
  return out;
}

function normalizeCamera(value: ViewerCamera | undefined, context: string): ViewerCamera | undefined {
  if (value === undefined || value === "fit") return value;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context}: camera must be "fit" or a Partial<Camera>, got ${JSON.stringify(value)}`);
  }
  for (const key of ["position", "target", "up"] as const) {
    const v = value[key];
    if (v !== undefined && (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite))) {
      throw new Error(`${context}: camera.${key} must be a [x, y, z] number triple`);
    }
  }
  if (value.navMode !== undefined && value.navMode !== "orbit" && value.navMode !== "fly") {
    throw new Error(`${context}: camera.navMode must be "orbit" or "fly"`);
  }
  if (value.projMode !== undefined && value.projMode !== "perspective" && value.projMode !== "orthographic") {
    throw new Error(`${context}: camera.projMode must be "perspective" or "orthographic"`);
  }
  return { ...value };
}

function normalizeControls(
  value: ViewerControlsConfig | undefined,
  context: string,
): ViewerControlsConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context}: controls must be an object, got ${JSON.stringify(value)}`);
  }
  const out: ViewerControlsConfig = {};
  for (const key of Object.keys(value)) assertControlName(key);
  for (const name of CONTROL_NAMES) {
    const v: unknown = value[name];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[name] = v;
    else if (typeof v === "object" && v !== null) out[name] = { ...(v as object) } as never;
    else throw new Error(`${context}: controls.${name} must be a boolean or an options object`);
  }
  return out;
}

function normalizeTools(
  value: ViewerToolsConfig | undefined,
  context: string,
): ViewerToolsConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context}: tools must be an object, got ${JSON.stringify(value)}`);
  }
  const out: ViewerToolsConfig = {};
  for (const key of Object.keys(value)) assertToolName(key);
  for (const name of TOOL_NAMES) {
    const v: unknown = value[name];
    if (v === undefined) continue;
    if (name === "magnifier") {
      if (v === false || v === "2d" || v === "3d") out.magnifier = v;
      else if (typeof v === "object" && v !== null) {
        const dim = (v as ViewerMagnifierOptions).dimension;
        if (dim !== undefined && dim !== "2d" && dim !== "3d") {
          throw new Error(`${context}: tools.magnifier.dimension must be "2d" or "3d"`);
        }
        out.magnifier = { ...(v as ViewerMagnifierOptions) };
      } else {
        throw new Error(`${context}: tools.magnifier must be false, "2d", "3d", or an options object`);
      }
      continue;
    }
    if (typeof v === "boolean") out[name] = v as never;
    else if (typeof v === "object" && v !== null) out[name] = { ...(v as object) } as never;
    else throw new Error(`${context}: tools.${name} must be a boolean or an options object`);
  }
  return out;
}

function normalizeAutoRotate(value: ViewerConfig["autoRotate"]): ViewerConfig["autoRotate"] {
  if (value === undefined || typeof value === "boolean") return value;
  if (value === null || typeof value !== "object") {
    throw new Error(`config.autoRotate must be a boolean or { speedDegPerSec }, got ${JSON.stringify(value)}`);
  }
  if (value.speedDegPerSec !== undefined && !Number.isFinite(value.speedDegPerSec)) {
    throw new Error(`config.autoRotate.speedDegPerSec must be a finite number, got ${JSON.stringify(value.speedDegPerSec)}`);
  }
  return { ...value };
}

function normalizeTransform(value: unknown, context: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length !== 16 || !value.every(Number.isFinite)
  ) {
    throw new Error(`${context} must be an array of 16 finite numbers (4×4 column-major affine), got ${JSON.stringify(value)}`);
  }
  return [...value];
}

function normalizeModeOverrides(value: ViewerModeOverrides | undefined): ViewerModeOverrides {
  const out: ViewerModeOverrides = {};
  if (value === undefined) return out;
  if (value === null || typeof value !== "object") {
    throw new Error(`modeOverrides must be an object keyed by mode, got ${JSON.stringify(value)}`);
  }
  for (const [mode, override] of Object.entries(value)) {
    assertResolvedMode(mode);
    if (override === undefined) continue;
    const next: ViewerModeOverride = {};
    if (override.channels) {
      next.channels = override.channels.map((entry) => ({
        ...entry,
        ...normalizeChannelPatch(entry, `modeOverrides.${mode}.channels`),
      }));
    }
    const camera = normalizeCamera(override.camera, `modeOverrides.${mode}`);
    if (camera !== undefined) next.camera = camera;
    const controls = normalizeControls(override.controls, `modeOverrides.${mode}`);
    if (controls !== undefined) next.controls = controls;
    const tools = normalizeTools(override.tools, `modeOverrides.${mode}`);
    if (tools !== undefined) next.tools = tools;
    const transform = normalizeTransform(override.transform, `modeOverrides.${mode}.transform`);
    if (transform !== undefined) next.transform = transform;
    out[mode as ResolvedViewerMode] = next;
  }
  return out;
}

// ============================================================================
// TRANSLATION HELPERS (§15.5)
// ============================================================================

type ViewKind = "volume" | "slice";

/** Quad layout: three orthogonal slice planes plus one volume view. */
const QUAD_PLANES = [
  { id: "quad-xy", axes: ["x", "y"] },
  { id: "quad-xz", axes: ["x", "z"] },
  { id: "quad-yz", axes: ["y", "z"] },
] as const;
const QUAD_VOLUME_ID = "quad-3d";
const MAIN_VIEW_ID = "main";

/** View id + kind pairs for a mode (drives per-view controls/tools). */
function viewEntriesForMode(mode: ResolvedViewerMode): { id: string; kind: ViewKind }[] {
  if (mode !== "quad") return [{ id: MAIN_VIEW_ID, kind: mode }];
  return [...QUAD_PLANES.map((p) => ({ id: p.id, kind: "slice" as const })), { id: QUAD_VOLUME_ID, kind: "volume" }];
}

/** Layer id prefixes for a mode — `<prefix>-c<channelIndex>` (`volume-c0`, `quad-xy-c0`, …). */
function layerPrefixesForMode(mode: ResolvedViewerMode): string[] {
  if (mode !== "quad") return [mode];
  return [...QUAD_PLANES.map((p) => p.id), QUAD_VOLUME_ID];
}

/** Expand the declarative control set into low-level `ViewConfig.controls`. */
function expandViewerControls(controls: ViewerControlsConfig): ControlOptions {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of CONTROL_NAMES) {
    const value = controls[name];
    if (value === undefined || value === false) continue;
    out[name] = value === true ? {} : { ...(value as Record<string, unknown>) };
  }
  return out as ControlOptions;
}

/** Expand the declarative tool set into low-level `ViewConfig.overlays`. */
function expandViewerTools(tools: ViewerToolsConfig | undefined, kind: ViewKind): OverlayOptions {
  const out: Record<string, Record<string, unknown>> = {};
  if (!tools) return out as OverlayOptions;
  const put = (type: string, value: boolean | object | undefined): void => {
    if (value === undefined || value === false) return;
    out[type] = value === true ? {} : { ...(value as Record<string, unknown>) };
  };
  put("crosshair", tools.crosshair);
  put("ruler", tools.ruler);
  put("roiselector", tools.roi);
  const magnifier = tools.magnifier;
  if (magnifier !== undefined && magnifier !== false) {
    let dimension: "2d" | "3d";
    let options: Record<string, unknown> = {};
    if (magnifier === "2d" || magnifier === "3d") {
      dimension = magnifier;
    } else {
      const { dimension: pin, ...rest } = magnifier;
      dimension = pin ?? (kind === "volume" ? "3d" : "2d");
      options = rest;
    }
    out[`magnifier-${dimension}`] = options;
  }
  return out as OverlayOptions;
}

/** Tool name → built-in overlay type(s) it maps to (DX-M6). */
function toolOverlayTypes(name: ViewerToolName): string[] {
  switch (name) {
    case "crosshair": return ["crosshair"];
    case "ruler":     return ["ruler"];
    case "roi":       return ["roiselector"];
    case "magnifier": return ["magnifier-2d", "magnifier-3d"];
  }
}

function mergeCamera(base: Camera, partial: Partial<Camera>): Camera {
  return {
    navMode  : partial.navMode ?? base.navMode,
    projMode : partial.projMode ?? base.projMode,
    position : partial.position ? [...partial.position] as Vec3 : [...base.position] as Vec3,
    target   : partial.target ? [...partial.target] as Vec3 : [...base.target] as Vec3,
    up       : partial.up ? [...partial.up] as Vec3 : base.up ? [...base.up] as Vec3 : undefined,
  };
}

/**
 * Capability-aware `"auto"` rule (§16): z=1 → slice; z>1 → volume when the
 * dataset supports 3D and the automatic tile-budget policy (DX-M4) yields a
 * valid bounded preview; otherwise slice.
 */
function resolveViewerMode(mode: ViewerMode, dataset: ResolvedDataset): ResolvedViewerMode {
  if (mode !== "auto") return mode;
  const caps = dataset.capabilities;
  if (caps.zDepth > 1 && caps.supports3D && caps.supportsVolumePreview) return "volume";
  return "slice";
}

// ============================================================================
// TARGET RESOLUTION
// ============================================================================

type ViewerTarget =
  | { kind: "canvas"; canvas: HTMLCanvasElement }
  | { kind: "container"; container: HTMLElement };

function isCanvasLike(el: unknown): el is HTMLCanvasElement {
  if (!el || typeof el !== "object") return false;
  if (typeof HTMLCanvasElement !== "undefined" && el instanceof HTMLCanvasElement) return true;
  return typeof (el as HTMLCanvasElement).getContext === "function";
}

function resolveTarget(element: string | HTMLElement | HTMLCanvasElement): ViewerTarget {
  let el: unknown = element;
  if (typeof element === "string") {
    if (typeof document === "undefined") {
      throw new Error(`createViewer: cannot resolve selector "${element}" — no document in this environment`);
    }
    el = document.querySelector(element);
    if (!el) throw new Error(`createViewer: no element matches selector "${element}"`);
  }
  if (isCanvasLike(el)) return { kind: "canvas", canvas: el };
  if (el && typeof (el as HTMLElement).appendChild === "function") {
    return { kind: "container", container: el as HTMLElement };
  }
  throw new Error(
    "createViewer: element must be a CSS selector, an HTMLElement container, or an HTMLCanvasElement",
  );
}

// ============================================================================
// VIEWER
// ============================================================================

/**
 * Viewer — one dataset session with modes, channels, camera, controls, and
 * tools. Create via {@link createViewer}; reach the low-level scene instance
 * through `viewer.galavi` for advanced composition.
 */
export class Viewer {
  private readonly _target: ViewerTarget;

  // Declarative intent (mirrored by `viewer.config`).
  private _source?: SourceDescriptor;
  private _mode: ViewerMode = "auto";
  private _projection: ViewerProjection = "mip";
  private _cameraConfig: ViewerCamera = "fit";
  private _controlsConfig?: ViewerControlsConfig;
  private _toolsConfig?: ViewerToolsConfig;
  private _channelOverrides = new Map<number, ViewerChannelPatch>();
  private _modeOverrides: ViewerModeOverrides = {};
  private _theme?: ViewerConfig["theme"];
  private _autoRotate?: ViewerConfig["autoRotate"];

  // Runtime state.
  private _dataset?: ResolvedDataset;
  private _galavi?: Galavi;
  private _unsubscribe?: () => void;
  /**
   * Live overlay instances per view, keyed by the registry type they were
   * created with. Rebuilt on every scene rebuild by zipping the view config's
   * overlay keys with `getOverlays()` (createView instantiates in
   * `Object.entries` order); runtime attach/detach keeps it current. Needed
   * because instance classes do not reliably self-report their registry type
   * (e.g. the magnifier's static `overlayType` is always `"magnifier-2d"`).
   */
  private _liveOverlays = new Map<string, Map<string, BaseOverlay>>();
  private _status: ViewerStatus = "idle";
  private _error?: unknown;
  private _resolvedMode?: ResolvedViewerMode;
  private _pendingMode?: ResolvedViewerMode;
  private _focus?: Vec3;
  private _revision = 0;
  private _ready: Promise<Viewer>;
  private _destroyed = false;

  // Viewer-owned DOM (container targets only).
  private _singleCanvas?: HTMLCanvasElement;
  private _quadGrid?: { el: HTMLElement; canvases: Record<string, HTMLCanvasElement> };

  constructor(target: ViewerTarget, config: ViewerConfig = {}) {
    this._target = target;
    if (config.mode !== undefined) assertViewerMode(config.mode);
    this._mode = config.mode ?? "auto";
    if (config.projection !== undefined) assertProjection(config.projection);
    this._projection = config.projection ?? "mip";
    this._cameraConfig = normalizeCamera(config.camera, "config") ?? "fit";
    this._controlsConfig = normalizeControls(config.controls, "config");
    this._toolsConfig = normalizeTools(config.tools, "config");
    for (const entry of config.channels ?? []) {
      if (!Number.isInteger(entry?.index) || entry.index < 0) {
        throw new Error(`config.channels: each entry needs a non-negative integer index, got ${JSON.stringify(entry)}`);
      }
      this._channelOverrides.set(
        entry.index,
        { ...this._channelOverrides.get(entry.index), ...normalizeChannelPatch(entry, "config.channels") },
      );
    }
    this._modeOverrides = normalizeModeOverrides(config.modeOverrides);
    this._theme = config.theme ? { ...config.theme } : undefined;
    this._autoRotate = normalizeAutoRotate(config.autoRotate);
    this._source = config.source;
    this._ready = Promise.resolve(this);
  }

  // === Accessors ===

  /** The resolved dataset, once open (decision 19.4 — `dataset` names the runtime object). */
  get dataset(): ResolvedDataset | undefined {
    return this._dataset;
  }

  /**
   * The low-level escape hatch (§15.1): the current Galavi instance. Replaced
   * on `open()` and on mode transitions — do not cache it across either.
   * Undefined until the first successful open.
   */
  get galavi(): Galavi | undefined {
    return this._galavi;
  }

  /** Load/transition status (DX-M2). */
  get status(): ViewerStatus {
    return this._status;
  }

  /** The recorded failure when `status === "error"` (DX-M2 cause chain). */
  get error(): unknown {
    return this._error;
  }

  /** Settles when the latest open/transition completes; rejects with its failure. */
  get ready(): Promise<Viewer> {
    return this._ready;
  }

  /** The configured mode (`"auto"` stays `"auto"`). */
  get mode(): ViewerMode {
    return this._mode;
  }

  /** The mode actually in effect after auto-resolution; undefined before the first open. */
  get resolvedMode(): ResolvedViewerMode | undefined {
    return this._resolvedMode;
  }

  /** Modes meaningful for the current dataset (§16: volume stays exposed for 3D data). */
  get availableModes(): ResolvedViewerMode[] {
    const caps = this._dataset?.capabilities;
    if (!caps) return [...RESOLVED_MODES];
    return caps.supports3D ? ["slice", "volume", "quad"] : ["slice"];
  }

  get projection(): ViewerProjection {
    return this._projection;
  }

  /** The primary canvas (the user canvas, or the viewer-owned one once created). */
  get canvas(): HTMLCanvasElement | undefined {
    if (this._target.kind === "canvas") return this._target.canvas;
    return this._singleCanvas ?? this._quadGrid?.canvases[QUAD_PLANES[0].id];
  }

  /**
   * The current declarative config — pure JSON (callbacks/runtime resources
   * are excluded by design, §15.2). Imperative changes are reflected here,
   * which is what makes the declarative/imperative parity (§15.4) testable.
   */
  get config(): ViewerConfig {
    const config: ViewerConfig = {};
    if (this._source) config.source = this._source;
    config.mode = this._mode;
    const channels = this._dataset
      ? this._baseChannels().map((c) => ({ ...c, contrast: [...c.contrast] as [number, number] }))
      : [...this._channelOverrides.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, patch]) => ({ index, ...patch }) as ViewerChannelConfig);
    if (channels.length > 0) config.channels = channels;
    config.projection = this._projection;
    config.camera = this._cameraConfig === "fit" ? "fit" : { ...this._cameraConfig };
    if (this._controlsConfig) config.controls = this._controlsConfig;
    if (this._toolsConfig) config.tools = this._toolsConfig;
    if (Object.keys(this._modeOverrides).length > 0) config.modeOverrides = this._modeOverrides;
    if (this._theme) config.theme = this._theme;
    if (this._autoRotate !== undefined) {
      config.autoRotate = typeof this._autoRotate === "object" ? { ...this._autoRotate } : this._autoRotate;
    }
    // Round-trip through JSON: drops any callback a caller smuggled into a
    // tools bag and proves the schema is function-free.
    return JSON.parse(JSON.stringify(config)) as ViewerConfig;
  }

  // === Open / status (DX-M2) ===

  /**
   * Open (or replace) the dataset. Resolves with the dataset once ready;
   * rejects with the resolver's error as-is (`cause` chains preserved) when
   * the source fails, or with {@link ViewerSupersededError} when a newer
   * open/transition wins. Last-write-wins: a superseded open never clobbers
   * newer state.
   */
  async open(source: SourceDescriptor): Promise<ResolvedDataset> {
    this._assertUsable("open");
    const revision = ++this._revision;
    this._source = source;
    this._error = undefined;
    this._status = "loading";
    const op = this._runOpen(source, revision);
    this._track(op);
    return op;
  }

  private async _runOpen(source: SourceDescriptor, revision: number): Promise<ResolvedDataset> {
    let dataset: ResolvedDataset;
    try {
      dataset = await openDataset(source);
    } catch (err) {
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    this._assertCurrent(revision, "open");
    this._dataset = dataset;
    await this._rebuild(revision, resolveViewerMode(this._mode, dataset), undefined);
    return dataset;
  }

  // === Mode transitions (DX-L2) ===

  /**
   * Switch visualization mode. Synchronous to call, asynchronous to complete
   * — `await viewer.ready` observes completion. Transitions preserve the
   * physical focus (the camera target survives; the new mode's fit framing is
   * translated onto it) and channel intent (the channel model reapplies to
   * the new mode's layers). Last-write-wins: rapid flips settle on the final
   * mode.
   */
  set mode(value: ViewerMode) {
    this._assertUsable("mode");
    assertViewerMode(value);
    this._mode = value;
    if (!this._dataset) return; // intent recorded; resolved on open
    const mode = resolveViewerMode(value, this._dataset);
    if (mode === "quad" && this._target.kind === "canvas") {
      throw new Error(
        'viewer.mode = "quad" requires a container element (the Viewer lays out four ' +
        "canvases); pass a container to createViewer instead of a canvas",
      );
    }
    if (mode === this._pendingMode) return; // already the latest intent
    this._pendingMode = mode;
    const revision = ++this._revision;
    this._track(this._rebuild(revision, mode, this._focus));
  }

  // === Channels (DX-M3) ===

  /**
   * Channel-level access — one operation per channel, no layer-ID scans.
   * The channel's config maps to the internal typed volume/slice layers
   * (nested `options.selection.c`).
   */
  channel(index: number): ViewerChannelAccessor {
    this._assertUsable("channel");
    if (!this._dataset) {
      throw new Error("viewer.channel(): no dataset open — call viewer.open(source) first");
    }
    if (!Number.isInteger(index) || index < 0 || index >= this._dataset.channels.length) {
      throw new Error(
        `viewer.channel(${index}): index out of range — the dataset has ` +
        `${this._dataset.channels.length} channel(s) (valid: 0..${this._dataset.channels.length - 1})`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get config(): ViewerChannelState {
        const channel = self._effectiveChannels(self._resolvedMode ?? "slice")
          .find((c) => c.index === index)!;
        return { ...channel, contrast: [...channel.contrast] as [number, number] };
      },
      configure(patch: ViewerChannelPatch): void {
        const normalized = normalizeChannelPatch(patch, `viewer.channel(${index}).configure`);
        self._channelOverrides.set(index, { ...self._channelOverrides.get(index), ...normalized });
        // Edit-what-you-see: when the ACTIVE mode carries its own channel
        // override (modeOverrides), a base-only edit would be masked by it in
        // the live apply. Merge the patch into the active mode's override too,
        // so the edit takes effect immediately and `viewer.config` mirrors
        // what the user sees.
        const mode = self._resolvedMode;
        const overrideChannels = mode ? self._modeOverrides[mode]?.channels : undefined;
        if (mode && overrideChannels?.some((c) => c.index === index)) {
          self._modeOverrides[mode] = {
            ...self._modeOverrides[mode],
            channels: overrideChannels.map((c) => (c.index === index ? { ...c, ...normalized } : c)),
          };
        }
        self._applyChannelLive(index);
      },
    };
  }

  /** Every channel's effective config (dataset defaults + overrides + active mode override). */
  get channels(): ViewerChannelState[] {
    if (!this._dataset) return [];
    return this._effectiveChannels(this._resolvedMode ?? "slice")
      .map((c) => ({ ...c, contrast: [...c.contrast] as [number, number] }));
  }

  // === Projection (DX-Q5) ===

  /** Volume accumulation projection — maps to `render.volumeProjection` on volume layers. */
  set projection(value: ViewerProjection) {
    this._assertUsable("projection");
    assertProjection(value);
    this._projection = value;
    if (!this._galavi || !this._resolvedMode) return;
    for (const id of this._volumeLayerIds(this._resolvedMode)) {
      this._galavi.layer(id)?.setRender({ volumeProjection: value });
    }
  }

  // === Camera ===

  /**
   * `"fit"` reframes the dataset bounds (same as {@link fitCamera}); a
   * `Partial<Camera>` merges over the CURRENT camera. At config time the
   * current camera IS the fit camera, so config and imperative paths agree.
   */
  setCamera(value: ViewerCamera): void {
    this._assertUsable("setCamera");
    const normalized = normalizeCamera(value, "viewer.setCamera") ?? "fit";
    this._cameraConfig = normalized;
    if (!this._galavi) return;
    if (normalized === "fit") {
      this.fitCamera();
      return;
    }
    const state = this._galavi.getState();
    state.exploration.camera = mergeCamera(state.exploration.camera, normalized);
    this._galavi.setState(state);
  }

  /** Reframe the dataset bounds for the current mode via the existing fit helpers. */
  fitCamera(): void {
    this._assertUsable("fitCamera");
    if (!this._galavi || !this._resolvedMode || !this._dataset) return;
    const state = this._galavi.getState();
    state.exploration.camera = this._fitCamera(this._resolvedMode);
    this._galavi.setState(state);
  }

  /**
   * Move the slice position of the active slice/quad mode: every slice layer
   * shows the slice at `point` along its through axis, and the camera focus is
   * translated onto `point` (position↔target offset preserved, same as mode
   * transitions). No-op before open or in volume mode.
   */
  setSlicePoint(point: Vec3): void {
    this._assertUsable("setSlicePoint");
    const galavi = this._galavi;
    const mode = this._resolvedMode;
    if (!galavi || !mode) return;
    if (!viewEntriesForMode(mode).some((entry) => entry.kind === "slice")) return;
    this._syncSliceLayers(mode, point);
    const state = galavi.getState();
    const camera = state.exploration.camera;
    const delta: Vec3 = [
      point[0] - camera.target[0],
      point[1] - camera.target[1],
      point[2] - camera.target[2],
    ];
    state.exploration.camera = {
      ...camera,
      target   : [...point] as Vec3,
      position : [
        camera.position[0] + delta[0],
        camera.position[1] + delta[1],
        camera.position[2] + delta[2],
      ] as Vec3,
    };
    galavi.setState(state);
    this._focus = [...point] as Vec3;
  }

  // === Controls and tools (DX-M6) ===

  /**
   * Runtime control access with the same typed options as the declarative
   * `controls` key. Controls are creation-only at the low level; the Viewer
   * re-instantiates the view's control chain through the control registry so
   * declarative and imperative paths agree (DX-M6).
   */
  control<K extends ViewerControlName>(name: K): ViewerControlAccessor<ViewerControlOptionsMap[K]> {
    this._assertUsable("control");
    assertControlName(name);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get enabled(): boolean {
        return self._isControlEnabled(name);
      },
      configure(options: Partial<ViewerControlOptionsMap[K]>): void {
        if (!options || typeof options !== "object") {
          throw new Error(`viewer.control("${name}").configure: options must be an object`);
        }
        const controls = { ...(self._controlsConfig ?? self._defaultControlsConfig()) };
        const prev = controls[name];
        controls[name] = { ...(prev && typeof prev === "object" ? prev : {}), ...options } as never;
        self._controlsConfig = controls;
        self._applyControlsLive();
      },
      enable(enabled = true): void {
        const controls = { ...(self._controlsConfig ?? self._defaultControlsConfig()) };
        const prev = controls[name];
        controls[name] = (enabled ? (prev && typeof prev === "object" ? prev : {}) : false) as never;
        self._controlsConfig = controls;
        self._applyControlsLive();
      },
    };
  }

  /**
   * Runtime tool access with the same typed options as the declarative
   * `tools` key. Tools map to built-in overlays (crosshair/ruler/roiselector/
   * magnifier-2d/3d) attached to the current mode's views.
   */
  tool<K extends ViewerToolName>(name: K): ViewerToolAccessor<ViewerToolOptionsMap[K]> {
    this._assertUsable("tool");
    assertToolName(name);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get enabled(): boolean {
        return self._isToolEnabled(name);
      },
      configure(options: Partial<ViewerToolOptionsMap[K]>): void {
        if (!options || typeof options !== "object") {
          throw new Error(`viewer.tool("${name}").configure: options must be an object`);
        }
        if (name === "magnifier") {
          const dim = (options as ViewerMagnifierOptions).dimension;
          if (dim !== undefined && dim !== "2d" && dim !== "3d") {
            throw new Error(`viewer.tool("magnifier").configure: dimension must be "2d" or "3d"`);
          }
        }
        const tools = { ...(self._toolsConfig ?? {}) };
        const prev = tools[name];
        tools[name] = { ...(prev && typeof prev === "object" ? prev : {}), ...options } as never;
        self._toolsConfig = tools;
        self._applyToolLive(name);
      },
      enable(enabled = true): void {
        const tools = { ...(self._toolsConfig ?? {}) };
        const prev = tools[name];
        // The magnifier schema has no bare `true` (a dimension or options bag
        // is required); enabling it fresh uses `{}` — kind-default dimension.
        tools[name] = (enabled
          ? (prev === undefined || prev === false ? (name === "magnifier" ? {} : true) : prev)
          : false) as never;
        self._toolsConfig = tools;
        self._applyToolLive(name);
      },
    };
  }

  // === Mode overrides ===

  /**
   * Imperative equivalent of `modeOverrides[mode]` (§15.4): merge per-mode
   * overrides; applies immediately (with focus preservation) when that mode
   * is the active one.
   */
  view(mode: ResolvedViewerMode): ViewerViewAccessor {
    this._assertUsable("view");
    assertResolvedMode(mode);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      configure(value: ViewerModeOverride): void {
        const normalized = normalizeModeOverrides({ [mode]: value })[mode] ?? {};
        const prev = self._modeOverrides[mode] ?? {};
        const next: ViewerModeOverride = { ...prev };
        if (normalized.channels) {
          const byIndex = new Map((prev.channels ?? []).map((c) => [c.index, c]));
          for (const entry of normalized.channels) {
            byIndex.set(entry.index, { ...byIndex.get(entry.index), ...entry });
          }
          next.channels = [...byIndex.values()].sort((a, b) => a.index - b.index);
        }
        if (normalized.camera !== undefined) next.camera = normalized.camera;
        if (normalized.controls !== undefined) next.controls = { ...prev.controls, ...normalized.controls };
        if (normalized.tools !== undefined) next.tools = { ...prev.tools, ...normalized.tools };
        if (normalized.transform !== undefined) next.transform = normalized.transform;
        self._modeOverrides[mode] = next;
        if (self._dataset && self._resolvedMode === mode) self._reenter();
      },
    };
  }

  // === Teardown ===

  /** Destroy the low-level instance, detach viewer-owned DOM, supersede in-flight work. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._revision; // supersede any in-flight open/transition
    this._teardownGalavi();
    this._removeOwnedDom();
    this._status = "idle";
    this._error = undefined;
  }

  // ==================================================================
  // INTERNALS
  // ==================================================================

  private _assertUsable(operation: string): void {
    if (this._destroyed) throw new Error(`viewer.${operation}: the Viewer has been destroyed`);
  }

  private _isCurrent(revision: number): boolean {
    return !this._destroyed && revision === this._revision;
  }

  private _assertCurrent(revision: number, operation: string, cleanup?: () => void): void {
    if (this._isCurrent(revision)) return;
    cleanup?.();
    throw new ViewerSupersededError(operation);
  }

  /** Track the latest operation; `ready` settles with it. */
  private _track(op: Promise<unknown>): void {
    const ready = op.then(() => this);
    // Keep rejections observable via `ready` without unhandled-rejection noise
    // for fire-and-forget callers.
    ready.catch(() => {});
    this._ready = ready;
  }

  private _teardownGalavi(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    const galavi = this._galavi;
    this._galavi = undefined;
    this._liveOverlays.clear();
    galavi?.destroy();
  }

  /**
   * Rebuild the low-level scene for `mode`: destroy the current Galavi,
   * translate the viewer state into a fresh GalaviConfig (§15.5), and
   * delegate creation/mounting to `createGalavi`. `focus` is the physical
   * point to preserve (mode transitions); undefined fits the dataset bounds.
   */
  private async _rebuild(revision: number, mode: ResolvedViewerMode, focus: Vec3 | undefined): Promise<void> {
    this._status = "loading";
    this._teardownGalavi();

    let galavi: Galavi;
    let config: GalaviConfig;
    try {
      const canvases = this._ensureCanvases(mode);
      config = this._buildGalaviConfig(mode, canvases, focus);
      galavi = await createGalavi(config);
    } catch (err) {
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    this._assertCurrent(revision, "mode transition", () => galavi.destroy());
    this._galavi = galavi;
    this._resolvedMode = mode;
    this._pendingMode = mode;
    this._focus = [...galavi.getState().exploration.camera.target] as Vec3;
    this._unsubscribe = galavi.subscribe((state) => {
      this._focus = [...state.exploration.camera.target] as Vec3;
    });
    // Zip the built overlay keys onto the live instances (createView
    // instantiates in Object.entries order).
    for (const { id } of viewEntriesForMode(mode)) {
      const keys = Object.keys(config.views[id].overlays ?? {});
      const instances = galavi.view(id).base.getOverlays();
      const byType = new Map<string, BaseOverlay>();
      keys.forEach((type, i) => byType.set(type, instances[i]));
      this._liveOverlays.set(id, byType);
    }

    const activeViewId = mode === "quad" ? QUAD_PLANES[0].id : MAIN_VIEW_ID;
    galavi.setActiveView(activeViewId);

    // Slice layers default to the center slice; a preserved focus must show
    // the slice AT the focus (DX-L2 focus preservation covers what is shown,
    // not just where the camera looks).
    if (focus) this._syncSliceLayers(mode, focus);

    // Surface any layer load failure with DX-M2 semantics. Layers carry the
    // dataset's explicit pyramid/fetch, so they report ready immediately —
    // this is the guard that keeps `open`'s "resolves ready" contract honest.
    const view = galavi.view(activeViewId);
    for (const id of this._layerIdsForMode(mode)) {
      const status = view.getLayerStatus(id);
      if (status?.status === "error") {
        const err = status.error ?? new Error(`Layer "${id}" failed to load`);
        if (this._isCurrent(revision)) {
          this._error = err;
          this._status = "error";
        }
        throw err;
      }
    }
    this._assertCurrent(revision, "mode transition");
    this._error = undefined;
    this._status = "ready";
  }

  /** Re-apply the current mode (mode-override change on the active mode). */
  private _reenter(): void {
    if (!this._resolvedMode) return;
    const revision = ++this._revision;
    this._track(this._rebuild(revision, this._resolvedMode, this._focus));
  }

  // === Translation (§15.5) ===

  private _requireDataset(): ResolvedDataset {
    if (!this._dataset) throw new Error("No dataset open — call viewer.open(source) first");
    return this._dataset;
  }

  /** Dataset channels + base overrides (no mode override) — the declarative `channels` mirror. */
  private _baseChannels(): ViewerChannelState[] {
    const dataset = this._requireDataset();
    return dataset.channels.map((channel) => {
      const patch = this._channelOverrides.get(channel.index) ?? {};
      return {
        index    : channel.index,
        label    : patch.label ?? channel.label,
        visible  : patch.visible ?? channel.visible,
        color    : patch.color ?? channel.color,
        contrast : (patch.contrast ?? channel.contrast) as [number, number],
      };
    });
  }

  /** Effective channels for `mode`: dataset defaults + base overrides + the mode override. */
  private _effectiveChannels(mode: ResolvedViewerMode): ViewerChannelState[] {
    const base = this._baseChannels();
    const override = this._modeOverrides[mode]?.channels;
    if (!override || override.length === 0) return base;
    const patches = new Map<number, ViewerChannelPatch>();
    for (const entry of override) {
      patches.set(entry.index, {
        ...patches.get(entry.index),
        ...normalizeChannelPatch(entry, `modeOverrides.${mode}.channels`),
      });
    }
    return base.map((channel) => {
      const patch = patches.get(channel.index);
      if (!patch) return channel;
      return {
        index    : channel.index,
        label    : patch.label ?? channel.label,
        visible  : patch.visible ?? channel.visible,
        color    : patch.color ?? channel.color,
        contrast : (patch.contrast ?? channel.contrast) as [number, number],
      };
    });
  }

  /** Layer IDs for every channel across the mode's views (`<prefix>-c<index>`). */
  private _layerIdsForMode(mode: ResolvedViewerMode): string[] {
    const dataset = this._requireDataset();
    const ids: string[] = [];
    for (const prefix of layerPrefixesForMode(mode)) {
      for (const channel of dataset.channels) ids.push(`${prefix}-c${channel.index}`);
    }
    return ids;
  }

  /** Layer IDs of the mode's VOLUME layers (projection targets). */
  private _volumeLayerIds(mode: ResolvedViewerMode): string[] {
    const dataset = this._requireDataset();
    const prefixes = mode === "volume" ? ["volume"] : mode === "quad" ? [QUAD_VOLUME_ID] : [];
    const ids: string[] = [];
    for (const prefix of prefixes) {
      for (const channel of dataset.channels) ids.push(`${prefix}-c${channel.index}`);
    }
    return ids;
  }

  /**
   * Push the slice containing `point` into every slice layer of `mode`
   * (per-view through axis, clamped to the layer's own range by the layer).
   * Slice layers default to the center slice, so mode entry with a preserved
   * focus and explicit `setSlicePoint` calls both go through here.
   */
  private _syncSliceLayers(mode: ResolvedViewerMode, point: Vec3): void {
    const galavi = this._galavi;
    if (!galavi || mode === "volume") return;
    const dataset = this._requireDataset();
    const spacing = dataset.physical.spatial.spacing ?? [1, 1, 1];
    const origin = dataset.physical.spatial.origin ?? [0, 0, 0];
    // Slice-layer prefixes with their in-plane axes: the mode name for the
    // main view (layers are `<mode>-cN`), the plane ids in quad.
    const planes: { prefix: string; axes: readonly string[] }[] = mode === "quad"
      ? QUAD_PLANES.map((p) => ({ prefix: p.id, axes: p.axes }))
      : [{ prefix: mode, axes: ["x", "y"] }];
    for (const { prefix, axes } of planes) {
      const through = resolveAxes(axes)[2];
      const index = Math.round((point[through] - origin[through]) / spacing[through]);
      for (const channel of dataset.channels) {
        galavi.layer(`${prefix}-c${channel.index}`)?.setOptions({ sliceIndex: index });
      }
    }
  }

  private _controlsFor(mode: ResolvedViewerMode, kind: ViewKind): ControlOptions {
    const declared = this._modeOverrides[mode]?.controls ?? this._controlsConfig;
    if (declared !== undefined) return expandViewerControls(declared);
    return (kind === "volume" ? { orbit: {} } : { panzoom: {} }) as ControlOptions;
  }

  private _overlaysFor(mode: ResolvedViewerMode, kind: ViewKind): OverlayOptions {
    const tools = this._modeOverrides[mode]?.tools ?? this._toolsConfig;
    return expandViewerTools(tools, kind);
  }

  private _fitCamera(mode: ResolvedViewerMode): Camera {
    const physical = this._requireDataset().physical;
    return mode === "slice"
      ? fitSliceCamera([0, 1, 2], physical)
      : frameVolumeCamera(physical);
  }

  /**
   * Camera for entering `mode`: the mode's fit framing, merged with the
   * declared camera (base config, then mode override), then translated onto
   * the preserved physical focus. An explicit `target` wins over the
   * preserved focus; a mode override of `camera: "fit"` forces a re-fit
   * (drops the preserved focus).
   */
  private _cameraFor(mode: ResolvedViewerMode, focus: Vec3 | undefined): Camera {
    const fit = this._fitCamera(mode);
    const overrideCamera = this._modeOverrides[mode]?.camera;
    const declared = overrideCamera ?? this._cameraConfig;
    let camera = fit;
    let explicitTarget = false;
    if (declared !== "fit") {
      camera = mergeCamera(fit, declared);
      explicitTarget = declared.target !== undefined;
    }
    if (focus && overrideCamera !== "fit" && !explicitTarget) {
      const delta: Vec3 = [
        focus[0] - camera.target[0],
        focus[1] - camera.target[1],
        focus[2] - camera.target[2],
      ];
      camera = {
        ...camera,
        target   : [...focus] as Vec3,
        position : [
          camera.position[0] + delta[0],
          camera.position[1] + delta[1],
          camera.position[2] + delta[2],
        ] as Vec3,
      };
    }
    return camera;
  }

  private _buildGalaviConfig(
    mode: ResolvedViewerMode,
    canvases: Record<string, HTMLCanvasElement>,
    focus: Vec3 | undefined,
  ): GalaviConfig {
    const dataset = this._requireDataset();
    const channels = this._effectiveChannels(mode);
    // Layer config (not runtime mutation): the mode's declared transform is
    // baked into every constructed layer's `data.transform`, so it survives
    // open/mode-transition rebuilds by construction.
    const transform = this._modeOverrides[mode]?.transform;
    const physical: PhysicalSpace = {
      ...dataset.physical,
      channels: { names: channels.map((c) => c.label) },
    };
    const layers: LayerConfig[] = [];
    const views: Record<string, ViewConfig> = {};

    const pushLayers = (prefix: string, kind: ViewKind, axes?: readonly string[]): string[] => {
      const ids: string[] = [];
      for (const channel of channels) {
        const id = `${prefix}-c${channel.index}`;
        const render: Render = {
          visible        : channel.visible,
          color          : channel.color,
          contrastLimits : [...channel.contrast] as [number, number],
          // One layer per channel composites fluorescence-style: additive is
          // the multichannel default for viewer-generated image layers.
          blending       : "additive",
          ...(kind === "volume" ? { volumeProjection: this._projection } : {}),
        };
        layers.push({
          id,
          type : kind,
          // The dataset's canonical descriptor stays on the layer for
          // provenance/serialization; the explicit pyramid/fetch win at
          // runtime (Data precedence), so no per-layer re-resolution happens.
          data    : {
            source: dataset.source,
            pyramid: dataset.pyramid,
            fetch: dataset.fetch,
            ...(transform !== undefined ? { transform: [...transform] } : {}),
          },
          render,
          options : {
            ...(axes ? { axes: [...axes] } : {}),
            selection: { ...dataset.defaultSelection, c: channel.index },
          },
        });
        ids.push(id);
      }
      return ids;
    };

    if (mode === "quad") {
      for (const plane of QUAD_PLANES) {
        views[plane.id] = {
          type     : "slice",
          canvas   : canvases[plane.id],
          layers   : pushLayers(plane.id, "slice", plane.axes),
          controls : this._controlsFor(mode, "slice"),
          overlays : this._overlaysFor(mode, "slice"),
        };
      }
      views[QUAD_VOLUME_ID] = {
        type     : "volume",
        canvas   : canvases[QUAD_VOLUME_ID],
        layers   : pushLayers(QUAD_VOLUME_ID, "volume"),
        controls : this._controlsFor(mode, "volume"),
        overlays : this._overlaysFor(mode, "volume"),
        ...(this._autoRotate ? { autoRotate: this._autoRotate } : {}),
      };
    } else {
      views[MAIN_VIEW_ID] = {
        type     : mode,
        canvas   : canvases[MAIN_VIEW_ID],
        layers   : pushLayers(mode, mode),
        controls : this._controlsFor(mode, mode),
        overlays : this._overlaysFor(mode, mode),
        ...(mode === "volume" && this._autoRotate ? { autoRotate: this._autoRotate } : {}),
      };
    }

    return {
      state: {
        physical,
        layers,
        exploration: { camera: this._cameraFor(mode, focus) },
      },
      views,
      ...(this._theme ? { theme: this._theme } : {}),
    };
  }

  // === Live application (imperative paths) ===

  private _applyChannelLive(index: number): void {
    const galavi = this._galavi;
    const mode = this._resolvedMode;
    if (!galavi || !mode) return;
    const channel = this._effectiveChannels(mode).find((c) => c.index === index)!;
    const render: Partial<Render> = {
      visible        : channel.visible,
      color          : channel.color,
      contrastLimits : [...channel.contrast] as [number, number],
    };
    for (const prefix of layerPrefixesForMode(mode)) {
      galavi.layer(`${prefix}-c${index}`)?.setRender(render);
    }
    // Channel labels live in the shared physical space.
    const state = galavi.getState();
    if (state.physical?.channels) {
      state.physical = {
        ...state.physical,
        channels: {
          ...state.physical.channels,
          names: this._effectiveChannels(mode).map((c) => c.label),
        },
      };
      galavi.setState(state);
    }
  }

  private _applyControlsLive(): void {
    const galavi = this._galavi;
    const mode = this._resolvedMode;
    if (!galavi || !mode) return;
    for (const { id, kind } of viewEntriesForMode(mode)) {
      const options = this._controlsFor(mode, kind);
      const controls: BaseControl[] = [];
      for (const [type, opts] of Object.entries(options)) {
        if (!opts) continue;
        controls.push(controlRegistry.create(type, `viewer-${id}-${type}`, opts as Record<string, unknown>));
      }
      galavi.view(id).base.setControls(controls);
    }
  }

  private _applyToolLive(name: ViewerToolName): void {
    const galavi = this._galavi;
    const mode = this._resolvedMode;
    if (!galavi || !mode) return;
    for (const { id, kind } of viewEntriesForMode(mode)) {
      const desired = this._overlaysFor(mode, kind);
      const base = galavi.view(id).base;
      const live = this._liveOverlays.get(id) ?? new Map<string, BaseOverlay>();
      this._liveOverlays.set(id, live);
      for (const type of toolOverlayTypes(name)) {
        const existing = live.get(type);
        const options = desired[type];
        if (options) {
          if (existing) {
            existing.setOptions(options);
          } else {
            const overlay: BaseOverlay = overlayRegistry.create(type);
            overlay.setOptions(options);
            base.addOverlay(overlay);
            live.set(type, overlay);
            const parent = base.canvasElement?.parentElement;
            if (parent) {
              try {
                overlay.mount(parent);
              } catch (e) {
                console.warn("Overlay mount failed", e);
              }
            }
          }
        } else if (existing) {
          base.removeOverlay(existing);
          live.delete(type);
        }
      }
    }
    galavi.requestRender();
  }

  private _defaultControlsConfig(): ViewerControlsConfig {
    const mode = this._resolvedMode ?? "slice";
    if (mode === "volume") return { orbit: true };
    if (mode === "quad") return { panzoom: true, orbit: true };
    return { panzoom: true };
  }

  private _isControlEnabled(name: ViewerControlName): boolean {
    const mode = this._resolvedMode;
    if (!mode) return false;
    const declared = this._modeOverrides[mode]?.controls ?? this._controlsConfig;
    if (declared !== undefined) {
      const value = declared[name];
      return value !== undefined && value !== false;
    }
    const defaults = this._defaultControlsConfig();
    return defaults[name] !== undefined && defaults[name] !== false;
  }

  private _isToolEnabled(name: ViewerToolName): boolean {
    const mode = this._resolvedMode;
    if (!mode) return false;
    const tools = this._modeOverrides[mode]?.tools ?? this._toolsConfig;
    const value = tools?.[name];
    if (value === undefined || value === false) return false;
    if (typeof value === "object" && (value as { visible?: boolean }).visible === false) return false;
    return true;
  }

  // === DOM ownership ===

  private _ownerDocument(container: HTMLElement): Document {
    const doc = container.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
    if (!doc) {
      throw new Error("createViewer: container targets need a DOM document in this environment");
    }
    return doc;
  }

  private _ensureCanvases(mode: ResolvedViewerMode): Record<string, HTMLCanvasElement> {
    if (this._target.kind === "canvas") {
      if (mode === "quad") {
        throw new Error(
          'mode "quad" requires a container element (the Viewer lays out four canvases); ' +
          "pass a container to createViewer instead of a canvas",
        );
      }
      return { [MAIN_VIEW_ID]: this._target.canvas };
    }
    const container = this._target.container;
    if (mode === "quad") {
      this._removeSingleCanvas();
      if (!this._quadGrid) {
        const doc = this._ownerDocument(container);
        const grid = doc.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "1fr 1fr";
        grid.style.gridTemplateRows = "1fr 1fr";
        grid.style.width = "100%";
        grid.style.height = "100%";
        const canvases: Record<string, HTMLCanvasElement> = {};
        for (const id of [...QUAD_PLANES.map((p) => p.id), QUAD_VOLUME_ID]) {
          const canvas = doc.createElement("canvas");
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.display = "block";
          grid.appendChild(canvas);
          canvases[id] = canvas;
        }
        container.appendChild(grid);
        this._quadGrid = { el: grid, canvases };
      }
      return this._quadGrid.canvases;
    }
    this._removeQuadGrid();
    if (!this._singleCanvas) {
      const doc = this._ownerDocument(container);
      const canvas = doc.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      container.appendChild(canvas);
      this._singleCanvas = canvas;
    }
    return { [MAIN_VIEW_ID]: this._singleCanvas };
  }

  private _removeSingleCanvas(): void {
    if (this._singleCanvas?.parentNode) {
      this._singleCanvas.parentNode.removeChild(this._singleCanvas);
    }
    this._singleCanvas = undefined;
  }

  private _removeQuadGrid(): void {
    if (this._quadGrid?.el.parentNode) {
      this._quadGrid.el.parentNode.removeChild(this._quadGrid.el);
    }
    this._quadGrid = undefined;
  }

  private _removeOwnedDom(): void {
    this._removeSingleCanvas();
    this._removeQuadGrid();
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a high-level Viewer on a selector, container, or canvas.
 *
 * - Selector / container: the Viewer creates and owns its canvas (a 2×2 grid
 *   of canvases in `"quad"` mode) inside the container.
 * - Canvas: framework ownership — the Viewer renders into it (`"quad"` mode
 *   is unavailable, it needs to own the layout).
 *
 * With `config.source`, the returned promise resolves only once the dataset
 * is open and ready; resolver failures reject with the actionable cause
 * (DX-M2 semantics). Without a source the viewer starts `idle` — call
 * `await viewer.open(source)`.
 */
export async function createViewer(
  element : string | HTMLElement | HTMLCanvasElement,
  config  : ViewerConfig = {},
): Promise<Viewer> {
  const viewer = new Viewer(resolveTarget(element), config);
  if (config.source) await viewer.open(config.source);
  return viewer;
}
