/**
 * Viewer — the high-level facade: one dataset session with a composition,
 * channels, camera, controls, and tools, translated onto the runtime's scene
 * model. `viewer.runtime` is the explicit escape hatch for advanced
 * composition.
 *
 * The facade consumes COMPOSITION PLANS only (the contract lives in
 * `./contract`; registration and resolution in `./compositions`): a resolved
 * composition builds a pure {@link CompositionPlan} — layers, canvas-free
 * views, host layout, and live-update bindings — and the Viewer drives
 * everything from it. No ID-prefix inference, no per-composition DOM
 * branches, no built-in enumeration outside the `"auto"` policy.
 *
 * The low-level orchestrator — `ViewerRuntime` + `createViewerRuntime` (the
 * state authority, the shared runtime layer map, the GPU device) — lives in
 * `./runtime` and is re-exported here so the public entry points stay
 * consolidated.
 *
 * Async discipline: `open()` and composition transitions are
 * last-write-wins. Every operation carries a revision token; a superseded
 * operation never clobbers newer state and rejects with
 * {@link ViewerSupersededError}. `viewer.ready` settles with the latest
 * operation; `viewer.status` tracks idle/loading/ready/error.
 */

import type {
  Camera,
  Data,
  LayerConfig,
  PhysicalSpace,
  Render,
  Vec3,
  VolumeRenderMode,
} from "../state/schema";
import {
  validateJsonObject,
  validateState,
  type ChannelState,
  type CompositionReference,
  type JsonObject,
  type JsonValue,
  type State,
} from "../state";
import {
  awaitConfiguredLayersReady,
  createViewerRuntime,
  type ControlOptions,
  type LayerPatch,
  type OverlayOptions,
  type ViewConfig,
  type ViewerRuntime,
  type ViewerRuntimeConfig,
} from "./runtime";
import type { DeepPartial, GalaviTheme } from "../primitives/overlay/theme";
import type {
  CrosshairOverlayOptions,
  MagnifierOverlayOptions,
  RoiSelectorOverlayOptions,
  RulerOverlayOptions,
} from "../primitives/overlay/options";
import { Dataset, openDataset, type DatasetConfig } from "../dataset";
import { clampContrastLimits, normalizeHexColor } from "../dataset";
import {
  compositionRegistry,
  ensureBuiltInCompositions,
  resolveAutoComposition,
  resolveComposition,
  supportedCompositions,
} from "./compositions";
import type {
  CompositionBuildInput,
  CompositionInput,
  CompositionPlan,
  ViewerComposition,
} from "./contract";
import { controlRegistry, overlayRegistry } from "../registry";
import type {
  BaseControl,
  FlyControlOptions,
  OrbitControlOptions,
  PanZoomControlOptions,
} from "../primitives/control";
import type { BaseOverlay, RoiBox, RoiSelectionChange } from "../primitives/overlay";
import {
  fitSliceCamera,
  frameVolumeCamera,
} from "../utils";

// ============================================================================
// LOW-LEVEL RUNTIME — re-exported from ./runtime
// ============================================================================

export { ViewerRuntime, createViewerRuntime } from "./runtime";
export type {
  ControlOptions,
  CreateViewerRuntimeOptions,
  LayerPatch,
  OverlayOptions,
  ViewConfig,
  ViewerRuntimeConfig,
} from "./runtime";


// ============================================================================
// VIEWER CONFIG
// ============================================================================

/** Volume ray-march accumulation — maps to low-level `render.volumeProjection`. */
export type ViewerProjection = VolumeRenderMode;

/** Viewer load/transition status. */
export type ViewerStatus = "idle" | "loading" | "ready" | "error";

/** One channel's declarative config — the `viewer.channel(index)` counterpart. */
export interface ViewerChannelConfig {
  /** Channel index — the `c` selection value of the underlying layers. */
  index     : number;
  /** Display label (defaults to the dataset's normalized label). */
  label?    : string;
  /** Visibility (defaults to metadata `active` flags, else first channel only). */
  visible?  : boolean;
  /** Display color, `#RRGGBB` (a missing `#` is added; malformed values throw). */
  color?    : string;
  /** Contrast window, clamped to normalized [0, 1] with low ≤ high. */
  contrast? : [number, number];
}

/** Initial/updated camera: `"fit"` frames the dataset bounds; a partial merges over it. */
export type ViewerCamera = "fit" | Partial<Camera>;

/**
 * Declarative control set. `true` enables with defaults, an options
 * bag enables with those options, `false`/absent disables. When `controls` is
 * present it fully specifies the control set for the current composition's
 * views; when absent, the plan default applies (orbit for volume views,
 * panzoom for slice views).
 */
export interface ViewerControlsConfig {
  orbit?   : boolean | OrbitControlOptions;
  fly?     : boolean | FlyControlOptions;
  panzoom? : boolean | PanZoomControlOptions;
}

/** Magnifier tool options: the overlay options plus an optional dimension pin. */
export type ViewerMagnifierOptions = MagnifierOverlayOptions & {
  /** Loupe dimension; defaults to `"3d"` on volume views, `"2d"` on slice views. */
  dimension?: "2d" | "3d";
};

/**
 * High-level ROI tool options: the JSON-serializable subset of the
 * low-level {@link RoiSelectorOverlayOptions}. The `onRoisChange` /
 * `onActiveIndexChange` callbacks are excluded by type, and passing them
 * anyway throws at runtime (never silently dropped). ROI changes reach the
 * application through the typed Viewer events — `viewer.on("roiChange" |
 * "roiActiveChange", handler)`; callback-bearing overlay options remain
 * available on the low-level runtime path
 * (`view.setOverlayOptions("roiselector", ...)`).
 */
export type ViewerRoiOptions = Omit<
  RoiSelectorOverlayOptions,
  "onRoisChange" | "onActiveIndexChange"
>;

/**
 * Declarative tool set. Tools map to built-in overlays: crosshair →
 * `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier →
 * `"magnifier-2d"`/`"magnifier-3d"`. `true` enables with defaults, an options
 * bag enables with those options, `false`/absent disables. When `tools` is
 * present it fully specifies the tool set. Options bags are JSON-serializable
 * intent: functions throw at validation.
 */
export interface ViewerToolsConfig {
  crosshair? : boolean | CrosshairOverlayOptions;
  ruler?     : boolean | RulerOverlayOptions;
  magnifier? : false | "2d" | "3d" | ViewerMagnifierOptions;
  roi?       : boolean | ViewerRoiOptions;
}

/**
 * Per-composition overrides applied when ENTERING that composition type
 * (scientifically justified per-composition contrast/tools). Imperative
 * equivalent: `viewer.composition(type).configure(value)`. Overrides layer over
 * the base config: channels merge per index, camera/controls/tools replace the
 * base value for that composition's entries when present. Serialized into
 * `State.compositions[type]`.
 */
export interface ViewerCompositionOverride {
  channels? : ViewerChannelConfig[];
  camera?   : ViewerCamera;
  controls? : ViewerControlsConfig;
  tools?    : ViewerToolsConfig;
  /**
   * Model transform for every layer CONSTRUCTED for this composition — a 4×4
   * column-major affine forwarded to each layer's `data.transform`. Because
   * it is layer config (not runtime mutation), it survives the Viewer's
   * open/composition-transition rebuilds by construction. Like the low-level
   * `data.transform`, it replaces the default physical-space scale/translate
   * (see `applyTransformConfig`), so the affine must encode the full
   * voxel→world mapping. Absent → the physical-space default.
   */
  transform? : number[];
}

/**
 * The minimal high-level viewer schema. JSON-serializable by contract: no
 * callbacks, no runtime resources.
 *
 * `state` is the restore path: it supplies the dataset descriptor and the
 * composition reference (plus channels/camera/…). It is mutually exclusive
 * with `dataset` and `composition` — combining them throws at creation, by
 * design (one source of truth; no merge precedence to guess at). Other config
 * fields (channels/projection/camera/controls/tools/theme/autoRotate) remain
 * creation-time preferences; document fields the state carries override them.
 */
export interface ViewerConfig {
  /**
   * Dataset source: a declarative config (opened via `openDataset` through the
   * dataset registry) or an already-loaded {@link Dataset} (adopted; ownership
   * transfers to the Viewer). Write the descriptor literally or build it with
   * the format's named helper — `omeZarr(source)` from `galavi/ome-zarr`,
   * `mesh(source)` from the root entry — which keeps loader selection explicit
   * (importing `galavi/ome-zarr` is what registers the `"ome-zarr"` kind).
   */
  dataset?      : DatasetConfig | Dataset;
  /**
   * Composition selection (default `"auto"`): `"auto"`, a declarative
   * `{ type, config? }` reference resolved through the composition registry,
   * or a direct `{ implementation, reference? }`. Imperative equivalent:
   * `await viewer.setComposition(input)`.
   */
  composition?  : CompositionInput;
  /** Restore document (dataset + composition + channels + camera + …). */
  state?        : State;
  /** Channel overrides over the dataset's normalized channels. */
  channels?     : ViewerChannelConfig[];
  /** Volume accumulation projection (default `"mip"`). */
  projection?   : ViewerProjection;
  /** Initial camera (default `"fit"` via the dataset bounds helpers). */
  camera?       : ViewerCamera;
  controls?     : ViewerControlsConfig;
  tools?        : ViewerToolsConfig;
  /** Per-composition overrides, keyed by composition type. */
  compositions? : Record<string, ViewerCompositionOverride>;
  /**
   * Overlay UI theme, merged over the runtime's default theme and forwarded to
   * the underlying `createViewerRuntime` call. Plain string bag — stays JSON-serializable.
   * Viewer-local presentation preference: NOT part of the portable `State`.
   */
  theme?        : DeepPartial<GalaviTheme>;
  /**
   * Idle camera spin for volume views — forwarded to the generated volume
   * `ViewConfig.autoRotate`. Absent/false disables (the low-level default).
   * Viewer-local preference: NOT part of the portable `State`.
   */
  autoRotate?   : boolean | { speedDegPerSec?: number };
}

// ============================================================================
// IMPERATIVE ACCESSORS
// ============================================================================

/** Channel patch accepted by `viewer.channel(index).configure`. */
export type ViewerChannelPatch = Partial<Omit<ViewerChannelConfig, "index">>;

/** `viewer.control(name)` handle. */
export interface ViewerControlAccessor<TOptions> {
  /** Whether the control is currently part of the active control set. */
  readonly enabled : boolean;
  /** Merge typed options and enable; same bag as the declarative key. */
  configure(options : Partial<TOptions>) : void;
  /** Enable (default options when never configured) or disable. */
  enable(enabled? : boolean) : void;
}

/** `viewer.tool(name)` handle. */
export interface ViewerToolAccessor<TOptions> {
  /** Whether the tool's overlay is currently attached and visible. */
  readonly enabled : boolean;
  /** Merge typed options and enable; same bag as the declarative key. */
  configure(options : Partial<TOptions>) : void;
  /** Enable (default options when never configured) or disable. */
  enable(enabled? : boolean) : void;
}

/** `viewer.channel(index)` handle. */
export interface ViewerChannelAccessor {
  /** Current effective channel state (dataset defaults + overrides). */
  readonly config : ChannelState;
  /** Merge a channel patch; same validation/default merge as `channels[n]`. */
  configure(patch : ViewerChannelPatch) : void;
}

/** `viewer.composition(type)` handle — the imperative `compositions[type]` equivalent. */
export interface ViewerCompositionAccessor {
  /** Merge per-composition overrides; applies immediately when that composition is active. */
  configure(value : ViewerCompositionOverride) : void;
}

/** Typed control names and their option bags. */
export interface ViewerControlOptionsMap {
  orbit   : OrbitControlOptions;
  fly     : FlyControlOptions;
  panzoom : PanZoomControlOptions;
}
export type ViewerControlName = keyof ViewerControlOptionsMap;

/** Typed tool names and their option bags (JSON-serializable). */
export interface ViewerToolOptionsMap {
  crosshair : CrosshairOverlayOptions;
  ruler     : RulerOverlayOptions;
  magnifier : ViewerMagnifierOptions;
  roi       : ViewerRoiOptions;
}
export type ViewerToolName = keyof ViewerToolOptionsMap;

// ============================================================================
// VIEWER EVENTS
// ============================================================================

/**
 * Payload of the high-level `"roiChange"` Viewer event: the full ROI list
 * after the change, what changed, and where it happened (the interacting view
 * plus the composition in effect — the quad composition attaches one ROI
 * overlay per view).
 */
export interface ViewerRoiChangeEvent {
  /** Full ROI list after the change (physical coordinates). */
  rois        : RoiBox[];
  /** Which ROI changed, how, and whether this is a live drag or the commit. */
  change      : RoiSelectionChange;
  /** The view the interaction happened in (e.g. `"main"`, `"quad-xy"`). */
  viewId      : string;
  /** The resolved composition type in effect when the change happened. */
  composition : string;
}

/** Payload of the high-level `"roiActiveChange"` Viewer event. */
export interface ViewerRoiActiveChangeEvent {
  /** The newly active ROI index, or null when none is active. */
  activeIndex : number | null;
  /** The view the interaction happened in (e.g. `"main"`, `"quad-xy"`). */
  viewId      : string;
  /** The resolved composition type in effect when the change happened. */
  composition : string;
}

/**
 * The typed high-level Viewer runtime events. Runtime notifications
 * live here — never in {@link ViewerConfig}, which stays JSON-serializable.
 * `viewer.on(name, handler)` returns an unsubscribe function; subscriptions
 * survive open/composition rebuilds and are cleared on `destroy()`.
 */
export interface ViewerEventMap {
  roiChange       : ViewerRoiChangeEvent;
  roiActiveChange : ViewerRoiActiveChangeEvent;
}
export type ViewerEventName = keyof ViewerEventMap;

// ============================================================================
// ERRORS + VALIDATION
// ============================================================================

/** Rejection reason for an `open()`/composition transition superseded by a newer call. */
export class ViewerSupersededError extends Error {
  constructor(operation: string) {
    super(`${operation} superseded by a newer call — the latest call wins`);
    this.name = "ViewerSupersededError";
  }
}

const PROJECTIONS: readonly ViewerProjection[] = ["mip", "minip", "mean"];
const CONTROL_NAMES: readonly ViewerControlName[] = ["orbit", "fly", "panzoom"];
const TOOL_NAMES: readonly ViewerToolName[] = ["crosshair", "ruler", "magnifier", "roi"];

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

const EVENT_NAMES: readonly ViewerEventName[] = ["roiChange", "roiActiveChange"];

function assertEventName(value: unknown): asserts value is ViewerEventName {
  if (!EVENT_NAMES.includes(value as ViewerEventName)) {
    throw new Error(`Unknown viewer event: ${JSON.stringify(value)} (expected one of: ${EVENT_NAMES.join(", ")})`);
  }
}

/**
 * Reject functions in a high-level tool options bag: the Viewer
 * config surface is JSON-serializable intent, so a function value means the
 * caller wants a runtime callback — fail loudly with the supported path
 * instead of letting the `viewer.getState()` JSON mirror silently drop it.
 */
function assertSerializableToolOptions(
  name    : ViewerToolName,
  options : Record<string, unknown>,
  context : string,
): void {
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== "function") continue;
    throw new Error(
      `${context}: tools.${name}.${key} is a function — high-level tool options are JSON-serializable only. ` +
      (name === "roi"
        ? 'Subscribe via viewer.on("roiChange" | "roiActiveChange", handler) for ROI notifications, ' +
          'or use the low-level runtime path: view.setOverlayOptions("roiselector", { onRoisChange }).'
        : "Callback-bearing overlay options live on the low-level runtime path: view.setOverlayOptions(...)."),
    );
  }
}

/**
 * Validate a composition selection (`ViewerConfig.composition`,
 * `viewer.setComposition`): `"auto"`, a declarative reference
 * (`{ type, config? }` — config JSON-checked), or a direct
 * `{ implementation, reference? }` (implementation shape-checked).
 */
function normalizeCompositionInput(value: unknown, context: string): CompositionInput {
  if (value === "auto") return "auto";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${context}: composition must be "auto", a { type, config? } reference, or ` +
      `{ implementation, reference? }, got ${JSON.stringify(value)}`,
    );
  }
  const raw = value as Record<string, unknown>;
  if ("implementation" in raw) {
    for (const key of Object.keys(raw)) {
      if (key !== "implementation" && key !== "reference") {
        throw new Error(`${context}: unknown key "${key}" (expected: implementation, reference)`);
      }
    }
    const implementation = raw.implementation as ViewerComposition;
    if (
      !implementation || typeof implementation !== "object" ||
      typeof implementation.type !== "string" || implementation.type.length === 0 ||
      typeof implementation.supports !== "function" || typeof implementation.build !== "function"
    ) {
      throw new Error(
        `${context}.implementation must be a ViewerComposition ({ type, supports, build }), ` +
        `got ${JSON.stringify(raw.implementation)}`,
      );
    }
    if (implementation.type === "auto") {
      throw new Error(
        `${context}.implementation.type must be a concrete composition type — ` +
        '"auto" is selection intent, never a composition type',
      );
    }
    const reference = raw.reference === undefined
      ? undefined
      : normalizeCompositionReference(raw.reference, `${context}.reference`);
    return { implementation, ...(reference ? { reference } : {}) };
  }
  return normalizeCompositionReference(raw, context);
}

function normalizeCompositionReference(
  input   : unknown,
  context : string,
): CompositionReference {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      `${context} must be a composition reference object ({ type, config? }), got ${JSON.stringify(input)}`,
    );
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "config") {
      throw new Error(`${context}: unknown key "${key}" (expected: type, config)`);
    }
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error(`${context}.type must be a non-empty composition type string, got ${JSON.stringify(value.type)}`);
  }
  if (value.type === "auto") {
    throw new Error(
      `${context}: "auto" is creation-time selection intent — pass it directly, ` +
      "never as a reference type",
    );
  }
  const config = value.config === undefined
    ? undefined
    : validateJsonObject(value.config, `${context}.config`);
  return { type: value.type, ...(config ? { config } : {}) };
}

// ============================================================================
// NORMALIZATION (shared by the declarative and imperative paths — §15.4)
// ============================================================================

/**
 * Validate and normalize one channel patch. Used identically for config
 * `channels[n]`, per-composition override channel entries, and
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
        assertSerializableToolOptions(name, v as Record<string, unknown>, context);
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
    else if (typeof v === "object" && v !== null) {
      assertSerializableToolOptions(name, v as Record<string, unknown>, context);
      out[name] = { ...(v as object) } as never;
    }
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

/**
 * Validate the per-composition override map:
 * keyed by composition type — an open string, resolved against the registry
 * only when the composition is entered.
 */
function normalizeCompositionOverrides(
  value   : Record<string, ViewerCompositionOverride> | Record<string, JsonObject> | undefined,
  context : string,
): Record<string, ViewerCompositionOverride> {
  const out: Record<string, ViewerCompositionOverride> = {};
  if (value === undefined) return out;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context} must be an object keyed by composition type, got ${JSON.stringify(value)}`);
  }
  for (const [type, override] of Object.entries(value)) {
    if (type === "auto") {
      throw new Error(`${context}: "auto" is selection intent, not a composition type`);
    }
    if (override === undefined) continue;
    const next: ViewerCompositionOverride = {};
    const bag = override as ViewerCompositionOverride;
    if (bag.channels) {
      next.channels = bag.channels.map((entry) => ({
        ...entry,
        ...normalizeChannelPatch(entry, `${context}.${type}.channels`),
      }));
    }
    const camera = normalizeCamera(bag.camera, `${context}.${type}`);
    if (camera !== undefined) next.camera = camera;
    const controls = normalizeControls(bag.controls, `${context}.${type}`);
    if (controls !== undefined) next.controls = controls;
    const tools = normalizeTools(bag.tools, `${context}.${type}`);
    if (tools !== undefined) next.tools = tools;
    const transform = normalizeTransform(bag.transform, `${context}.${type}.transform`);
    if (transform !== undefined) next.transform = transform;
    out[type] = next;
  }
  return out;
}

/** Key-order-insensitive deep equality over JSON values (dataset-descriptor compare). */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((entry, i) => jsonEquals(entry, (b as unknown[])[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  return aKeys.length === bKeys.length
    && aKeys.every((key) =>
      key in (b as Record<string, unknown>)
      && jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

// ============================================================================
// PLAN TRANSLATION HELPERS
// ============================================================================

/** Fallback framing for datasets that report no physical space ([0,1]³). */
const DEFAULT_PHYSICAL: PhysicalSpace = { spatial: { size: [1, 1, 1] } };

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
function expandViewerTools(tools: ViewerToolsConfig | undefined, viewType: string): OverlayOptions {
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
      dimension = pin ?? (viewType === "volume" ? "3d" : "2d");
      options = rest;
    }
    out[`magnifier-${dimension}`] = options;
  }
  return out as OverlayOptions;
}

/** Tool name → built-in overlay type(s) it maps to. */
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

// ============================================================================
// PLAN DIFFING (config-only reapplication — ONE commit per batch)
// ============================================================================

/** Runtime-data identity: a change here means the plan cannot be patched in place. */
function sameLayerData(a: Data | undefined, b: Data | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.url === b.url
    && a.urlTemplate === b.urlTemplate
    && a.pyramid === b.pyramid
    && a.fetch === b.fetch
    && a.geometry === b.geometry
    && jsonEquals(a.transform ?? null, b.transform ?? null);
}

/**
 * Whether `next` can be applied onto the scene built from `prev` WITHOUT an
 * runtime rebuild: same layout, same view ids/types/layer wiring, and the same
 * layer set with identical runtime data. Only portable layer state (render /
 * options) may differ — e.g. a grid page turn (sliceIndex + visibility).
 */
function plansCompatible(prev: CompositionPlan, next: CompositionPlan): boolean {
  if (!jsonEquals(prev.layout, next.layout)) return false;
  const prevViewIds = Object.keys(prev.views);
  const nextViewIds = Object.keys(next.views);
  if (prevViewIds.length !== nextViewIds.length) return false;
  for (const id of prevViewIds) {
    const a = prev.views[id];
    const b = next.views[id];
    if (!b || a.type !== b.type || !jsonEquals(a.layers, b.layers)) return false;
  }
  const prevLayers = new Map(prev.layers.map((layer) => [layer.id, layer]));
  if (prevLayers.size !== next.layers.length) return false;
  for (const layer of next.layers) {
    const prevLayer = prevLayers.get(layer.id);
    if (!prevLayer || prevLayer.type !== layer.type) return false;
    if (!sameLayerData(prevLayer.data, layer.data)) return false;
  }
  return true;
}

/**
 * The batched patch list bringing the live layers to the plan's declared
 * render/options state. Only keys the plan DECLARES are patched (never
 * deleted): a focus-synced `sliceIndex` on the live scene survives when the
 * plan does not declare one. Callers must check {@link plansCompatible} first.
 */
function diffPlanLayers(liveLayers: LayerConfig[], plan: CompositionPlan): LayerPatch[] {
  const liveById = new Map(liveLayers.map((layer) => [layer.id, layer]));
  const patches: LayerPatch[] = [];
  for (const next of plan.layers) {
    const live = liveById.get(next.id);
    if (!live) continue;
    const patch: LayerPatch = { id: next.id };
    if (next.render) {
      const render: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next.render)) {
        if (!jsonEquals((live.render as Record<string, unknown> | undefined)?.[key], value)) {
          render[key] = value;
        }
      }
      if (Object.keys(render).length > 0) patch.render = render as Partial<Render>;
    }
    if (next.options) {
      const options: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next.options as Record<string, unknown>)) {
        if (!jsonEquals((live.options as Record<string, unknown> | undefined)?.[key], value)) {
          options[key] = value;
        }
      }
      if (Object.keys(options).length > 0) patch.options = options;
    }
    if (patch.render !== undefined || patch.options !== undefined) patches.push(patch);
  }
  return patches;
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
 * A resolved composition selection: the implementation to build with, its
 * public type, and its portable identity (`reference` — undefined only for a
 * direct implementation supplied without one, which makes the session
 * unexportable: `getState()` then fails explicitly). `configInput` is the
 * config carried explicitly by the selection input (it replaces the stored
 * per-type config when present).
 */
interface ResolvedComposition {
  type           : string;
  implementation : ViewerComposition;
  reference?     : CompositionReference;
  configInput?   : JsonObject;
}

/**
 * Viewer — one dataset session with a composition, channels, camera,
 * controls, and tools. Create via {@link createViewer}; reach the low-level
 * scene instance through `viewer.runtime` for advanced composition.
 */
export class Viewer {
  private readonly _target: ViewerTarget;

  // Declarative intent (mirrored by `viewer.getState()`; the dataset
  // descriptor lives on the open Dataset itself — `dataset.config`).
  private _compositionSelection: CompositionInput = "auto";
  private _projection: ViewerProjection = "mip";
  private _cameraConfig: ViewerCamera = "fit";
  private _controlsConfig?: ViewerControlsConfig;
  private _toolsConfig?: ViewerToolsConfig;
  private _channelOverrides = new Map<number, ViewerChannelPatch>();
  /** Per-composition overrides, keyed by composition type. */
  private _compositionOverrides: Record<string, ViewerCompositionOverride> = {};
  /** Per-composition portable configs, keyed by composition type (normalized plan configs). */
  private _compositionConfigs = new Map<string, JsonObject>();
  private _theme?: ViewerConfig["theme"];
  private _autoRotate?: ViewerConfig["autoRotate"];

  // Runtime state.
  private _dataset?: Dataset;
  private _runtime?: ViewerRuntime;
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
  /** The committed scene: the resolved composition plus the plan it built. */
  private _resolved?: ResolvedComposition & { plan: CompositionPlan };
  private _pendingType?: string;
  private _focus?: Vec3;
  private _revision = 0;
  private _ready: Promise<Viewer>;
  private _destroyed = false;

  /**
   * High-level event subscriptions. They live on the Viewer — not on
   * any runtime/overlay instance — so they survive open/composition rebuilds;
   * the forwarders are re-attached to each new scene's roiselector overlays.
   * Cleared on `destroy()`.
   */
  private readonly _eventHandlers: {
    [K in ViewerEventName]: Set<(event: ViewerEventMap[K]) => void>;
  } = {
    roiChange       : new Set(),
    roiActiveChange : new Set(),
  };

  /**
   * Portable-state subscriptions. Like the event subscriptions they live on
   * the Viewer, so they survive open/composition/setState rebuilds; each
   * committed rebuild emits exactly one snapshot. Cleared on `destroy()`.
   */
  private readonly _stateListeners = new Set<(state: State) => void>();

  // Viewer-owned DOM (container targets only).
  private _singleCanvas?: HTMLCanvasElement;
  private _multiHost?: { el: HTMLElement; canvases: Record<string, HTMLCanvasElement>; key: string };

  constructor(target: ViewerTarget, config: ViewerConfig = {}) {
    this._target = target;
    if (config.state !== undefined && (config.dataset !== undefined || config.composition !== undefined)) {
      throw new Error(
        "createViewer: config.state supplies the dataset and the composition — " +
        "do not combine it with config.dataset or config.composition",
      );
    }
    this._compositionSelection = normalizeCompositionInput(config.composition ?? "auto", "config.composition");
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
    this._compositionOverrides = normalizeCompositionOverrides(config.compositions, "config.compositions");
    this._theme = config.theme ? { ...config.theme } : undefined;
    this._autoRotate = normalizeAutoRotate(config.autoRotate);
    this._ready = Promise.resolve(this);
  }

  // === Accessors ===

  /** The opened dataset, once open (`dataset` names the runtime object). */
  get dataset(): Dataset | undefined {
    return this._dataset;
  }

  /**
   * The low-level escape hatch: the current ViewerRuntime instance. Replaced
   * on `open()` and on composition transitions — do not cache it across
   * either. Undefined until the first successful open.
   */
  get runtime(): ViewerRuntime | undefined {
    return this._runtime;
  }

  /** Load/transition status. */
  get status(): ViewerStatus {
    return this._status;
  }

  /** The recorded failure when `status === "error"`. */
  get error(): unknown {
    return this._error;
  }

  /** Settles when the latest open/transition completes; rejects with its failure. */
  get ready(): Promise<Viewer> {
    return this._ready;
  }

  /** The composition type actually in effect; undefined before the first open. */
  get resolvedComposition(): string | undefined {
    return this._resolved?.type;
  }

  /**
   * Registered composition types supporting the current dataset, in
   * resolution order, intersected with what the target layout can host (a
   * caller-owned canvas hosts only single-view compositions — multi-view
   * layouts need the Viewer to own the DOM). Before the first open — no
   * dataset — every registered type is listed.
   */
  get availableCompositions(): string[] {
    ensureBuiltInCompositions();
    if (!this._dataset) return compositionRegistry.keys();
    const dataset = this._dataset;
    return supportedCompositions(dataset).filter((type) => {
      try {
        const plan = resolveComposition(type).build(this._buildInput(type, dataset));
        return this._targetSupportsPlan(plan);
      } catch {
        return false;
      }
    });
  }

  get projection(): ViewerProjection {
    return this._projection;
  }

  /** The primary canvas (the user canvas, or the viewer-owned one once created). */
  get canvas(): HTMLCanvasElement | undefined {
    if (this._target.kind === "canvas") return this._target.canvas;
    return this._singleCanvas
      ?? (this._multiHost ? Object.values(this._multiHost.canvases)[0] : undefined);
  }

  // === Portable state ===

  /**
   * The portable state snapshot: the normalized, JSON-pure {@link State} of
   * the current session — the dataset's declarative descriptor, the resolved
   * composition reference (never `"auto"`), fully resolved channels, the
   * CURRENT live camera (control-driven changes included), current ROI tool
   * values, the projection, and the per-composition overrides. Restore it
   * with {@link Viewer.setState}; transport it as plain JSON.
   *
   * Throws when no scene is committed (an idle or error-state viewer without
   * an runtime has no portable state), and when the active composition was
   * supplied as a direct implementation WITHOUT a portable `reference` — an
   * unportable document is never emitted silently.
   */
  getState(): State {
    this._assertUsable("getState");
    const runtime = this._runtime;
    const dataset = this._dataset;
    const resolved = this._resolved;
    if (!runtime || !dataset || !resolved) {
      throw new Error(
        "viewer.getState(): no committed scene — open a dataset (viewer.open / viewer.setState) " +
        "and await the operation first; an idle or error-state viewer has no portable state",
      );
    }
    if (!resolved.reference) {
      throw new Error(
        `viewer.getState(): the active composition "${resolved.type}" was supplied as a direct ` +
        "implementation without a portable `reference` — the document cannot name it. Pass " +
        "`{ implementation, reference: { type } }` or register the composition via " +
        "registerComposition() before exporting state",
      );
    }
    const camera = runtime.getState().exploration.camera;
    const compositionConfig = this._compositionConfigs.get(resolved.type);
    const tools = this._toolStateValues();
    const state: State = {
      dataset    : dataset.config,
      composition: {
        type: resolved.type,
        ...(compositionConfig ? { config: { ...compositionConfig } } : {}),
      },
      channels    : this._effectiveChannels(resolved.type),
      projection  : this._projection,
      exploration : {
        camera: {
          navMode  : camera.navMode,
          projMode : camera.projMode,
          position : [...camera.position] as Vec3,
          target   : [...camera.target] as Vec3,
          ...(camera.up ? { up: [...camera.up] as Vec3 } : {}),
        },
      },
      ...(tools ? { tools } : {}),
      ...(Object.keys(this._compositionOverrides).length > 0
        ? { compositions: this._compositionOverrides as unknown as Record<string, JsonObject> }
        : {}),
    };
    // Canonicalize through the shared structural validator: the emitted
    // document is a deep JSON clone, exactly what setState accepts.
    return validateState(state, "viewer.getState");
  }

  /**
   * Restore a portable {@link State} atomically:
   *
   * 1. The document is validated FIRST (`validateState` — structural) — a
   *    shape/validation error rejects without touching the current viewer
   *    (status, scene, and recorded intent are fully preserved).
   * 2. A changed dataset descriptor opens under the existing last-write-wins
   *    lifecycle BEFORE anything is torn down; an unchanged descriptor reuses
   *    the live dataset (no duplicate metadata open). Open failure preserves
   *    the current scene and records the error.
   * 3. The composition reference resolves in PREFLIGHT (unknown types reject
   *    with `CapabilityResolutionError`), and support/target checks run
   *    against the opened dataset BEFORE teardown.
   * 4. Channels, projection, per-composition overrides, tool values, the
   *    concrete camera, and the slice focus apply in ONE rebuild.
   * 5. On GPU/mount failure after preflight the viewer enters `error`, the
   *    replacement resources are disposed, and no partial high-level state or
   *    leaked runtime remains (the old scene is not guaranteed past the
   *    canvas handoff point).
   * 6. Exactly ONE state notification fires for the committed state.
   *
   * Last-write-wins: a superseded call rejects with
   * {@link ViewerSupersededError}; rapid calls settle on the final state.
   */
  async setState(state: State): Promise<void> {
    this._assertUsable("setState");
    // Step 1 — document validation: synchronous; the current viewer is fully
    // preserved when it fails.
    const normalized = validateState(state, "viewer.setState");
    const revision = ++this._revision;
    this._error = undefined;
    this._status = "loading";
    const op = this._runSetState(normalized, revision);
    this._track(op);
    await op;
  }

  private async _runSetState(state: State, revision: number): Promise<void> {
    // Step 2 — dataset: open a changed descriptor before any teardown.
    let dataset = this._dataset;
    let openedHere = false;
    if (state.dataset !== undefined && !jsonEquals(state.dataset, dataset?.config)) {
      try {
        dataset = await openDataset(state.dataset);
      } catch (err) {
        if (this._isCurrent(revision)) {
          this._error = err;
          this._status = "error";
        }
        throw err;
      }
      openedHere = true;
    }
    // A superseding call won while the dataset opened — release the fresh one.
    this._assertCurrent(revision, "setState", () => { if (openedHere) dataset?.dispose(); });
    if (!dataset) {
      const err = new Error(
        "viewer.setState: state.dataset is required — the viewer has no dataset open " +
        "and the state carries no descriptor to open",
      );
      this._error = err;
      this._status = "error";
      throw err;
    }
    // Step 3 — semantic + capability preflight, BEFORE committing anything:
    // per-composition overrides, channel states, and tool values normalize;
    // the composition reference resolves (unknown types reject with
    // CapabilityResolutionError) and its plan builds against the dataset.
    let resolved: ResolvedComposition;
    let plan: CompositionPlan;
    let overrides: Record<string, ViewerCompositionOverride>;
    let channelOverrides: Map<number, ViewerChannelPatch>;
    let toolsConfig: ViewerToolsConfig | undefined;
    try {
      overrides = state.compositions !== undefined
        ? normalizeCompositionOverrides(state.compositions, "state.compositions")
        : this._compositionOverrides;
      channelOverrides = state.channels !== undefined
        ? new Map(state.channels.map((channel) => [
          channel.index,
          {
            label    : channel.label,
            visible  : channel.visible,
            color    : channel.color,
            contrast : [...channel.contrast] as [number, number],
          },
        ]))
        : this._channelOverrides;
      toolsConfig = state.tools !== undefined
        ? this._toolsConfigWithValues(state.tools)
        : this._toolsConfig;
      const selection: CompositionInput = state.composition !== undefined
        ? state.composition
        : this._compositionSelection;
      const candidate = this._resolveComposition(selection, dataset);
      const projection = state.projection ?? this._projection;
      const prepared = this._prepareComposition(
        candidate,
        dataset,
        this._effectiveChannels(
          candidate?.type ?? this._selectedCompositionType() ?? "slice",
          dataset,
          channelOverrides,
          overrides,
        ),
        projection,
        candidate ? overrides[candidate.type]?.transform : undefined,
      );
      resolved = prepared.resolved;
      plan = prepared.plan;
    } catch (err) {
      if (openedHere) dataset.dispose();
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    // Step 4 — commit the high-level intent, then apply everything in one
    // rebuild. The previous dataset is released only at this commit point
    // (never the re-restored live instance itself).
    if (this._dataset !== dataset) this._dataset?.dispose();
    this._dataset = dataset;
    this._compositionSelection = { type: resolved.type };
    if (resolved.configInput !== undefined) {
      this._compositionConfigs.set(resolved.type, resolved.configInput);
    }
    this._projection = state.projection ?? this._projection;
    this._channelOverrides = channelOverrides;
    this._compositionOverrides = overrides;
    this._toolsConfig = toolsConfig;
    const camera: Camera = {
      navMode  : state.exploration.camera.navMode,
      projMode : state.exploration.camera.projMode,
      position : [...state.exploration.camera.position] as Vec3,
      target   : [...state.exploration.camera.target] as Vec3,
      ...(state.exploration.camera.up ? { up: [...state.exploration.camera.up] as Vec3 } : {}),
    };
    this._cameraConfig = camera;
    try {
      // The camera target is the canonical physical focus: slice/quad
      // restores synchronize every generated slice layer to it.
      await this._rebuild(revision, resolved, plan, [...camera.target] as Vec3, camera);
    } catch (err) {
      // Step 5 — post-preflight failure: the Viewer disposes the dataset it
      // owns (same ownership rule as open()), leaving no partial state. A
      // superseded call's dataset is the newer operation's responsibility.
      if (this._isCurrent(revision)) {
        dataset.dispose();
        if (this._dataset === dataset) this._dataset = undefined;
      }
      throw err;
    }
  }

  /**
   * Subscribe to committed state snapshots: the listener fires ONCE per
   * committed scene (open / composition transition / setState — one
   * notification for the committed state, never one per field). Live
   * interaction changes (camera drags, ROI edits, channel tweaks) do not
   * notify; read {@link Viewer.getState} when a fresh snapshot is needed.
   * Returns an unsubscribe function; `destroy()` clears all subscriptions.
   */
  subscribe(listener: (state: State) => void): () => void {
    this._assertUsable("subscribe");
    if (typeof listener !== "function") {
      throw new Error(`viewer.subscribe: listener must be a function, got ${typeof listener}`);
    }
    this._stateListeners.add(listener);
    return () => { this._stateListeners.delete(listener); };
  }

  /** Emit one committed snapshot to the state listeners (end of a successful rebuild). */
  private _notifyState(): void {
    if (this._stateListeners.size === 0 || !this._runtime || !this._resolved) return;
    // A direct composition without a portable reference is unexportable —
    // getState() throws on demand; never fail a rebuild over a notification.
    if (!this._resolved.reference) return;
    const snapshot = this.getState();
    for (const listener of this._stateListeners) listener(snapshot);
  }

  // === Open / status ===

  /**
   * Open (or replace) the dataset from a declarative config: a fresh Dataset
   * is constructed and loaded through the dataset registry, then owned by the
   * Viewer. Resolves with the dataset once ready; rejects with the load error
   * as-is (`cause` chains preserved) when the source fails, or with
   * {@link ViewerSupersededError} when a newer open/transition wins.
   * Last-write-wins: a superseded open never clobbers newer state.
   */
  open(config: DatasetConfig): Promise<Dataset>;
  /**
   * Adopt an already-loaded Dataset (e.g. one pre-opened via
   * `openOMEZarrDataset` for its format metadata). Ownership transfers AT
   * INVOCATION: after this call the caller must not dispose the instance,
   * even if the returned promise rejects — the Viewer disposes it on
   * supersession, replacement by a newer open, rebuild failure, and
   * {@link destroy}. (An invocation that itself THROWS — e.g. on a destroyed
   * viewer — never transfers ownership.) Same settlement contract as the
   * config overload.
   */
  open(dataset: Dataset): Promise<Dataset>;
  /** The union form (ViewerConfig.dataset) — dispatches to the two documented paths. */
  open(source: DatasetConfig | Dataset): Promise<Dataset>;
  async open(source: DatasetConfig | Dataset): Promise<Dataset> {
    this._assertUsable("open");
    const revision = ++this._revision;
    this._error = undefined;
    this._status = "loading";
    const op = this._runOpen(source, revision);
    this._track(op);
    return op;
  }

  private async _runOpen(source: DatasetConfig | Dataset, revision: number): Promise<Dataset> {
    let dataset: Dataset;
    if (source instanceof Dataset) {
      // Adoption: ownership transferred at invocation — from here on
      // only the Viewer disposes this instance. No load, no second open.
      dataset = source;
    } else {
      try {
        dataset = await openDataset(source);
      } catch (err) {
        if (this._isCurrent(revision)) {
          this._error = err;
          this._status = "error";
        }
        throw err;
      }
    }
    this._assertCurrent(revision, "open", () => dataset.dispose());
    // The new dataset won the race — release the previous one (never the new
    // instance itself: re-adopting the live dataset must not dispose it).
    if (this._dataset !== dataset) this._dataset?.dispose();
    this._dataset = dataset;
    let resolved: ResolvedComposition;
    let plan: CompositionPlan;
    try {
      const candidate = this._resolveComposition(this._compositionSelection, dataset);
      const prepared = this._prepareComposition(
        candidate,
        dataset,
        this._effectiveChannels(
          candidate?.type ?? this._selectedCompositionType() ?? "slice",
          dataset,
        ),
        this._projection,
        candidate ? this._compositionOverrides[candidate.type]?.transform : undefined,
      );
      resolved = prepared.resolved;
      plan = prepared.plan;
    } catch (err) {
      // A composition the dataset cannot host leaves the dataset open and
      // owned (the advanced path stays usable through viewer.runtime).
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    if (resolved.configInput !== undefined) {
      this._compositionConfigs.set(resolved.type, resolved.configInput);
    }
    try {
      await this._rebuild(revision, resolved, plan, undefined);
    } catch (err) {
      // Rebuild failure while this open is still current: the Viewer disposes
      // the dataset it owns. A superseded open's dataset was already
      // released by the winning replacement (or is still live under a newer
      // composition transition) — never dispose twice.
      if (this._isCurrent(revision)) {
        dataset.dispose();
        if (this._dataset === dataset) this._dataset = undefined;
      }
      throw err;
    }
    return dataset;
  }

  // === Composition transitions ===

  /**
   * Switch the composition and await the transition: the returned promise IS
   * the operation. It resolves once the new composition's scene is rebuilt
   * and its generated layers are structurally ready; it rejects with
   * {@link ViewerSupersededError} when a newer open/transition wins
   * (last-write-wins — rapid flips settle on the final composition), and with
   * the recorded load error when a generated layer's source fails. Because
   * the promise is the contract, fire-and-forget calls fail loudly (unhandled
   * rejection) instead of silently — `viewer.ready` remains the
   * swallow-guarded alternative for observing the latest operation.
   *
   * Transitions preserve the physical focus (the camera target survives; the
   * new composition's fit framing is translated onto it) and channel intent
   * (the channel model reapplies to the new composition's layers).
   *
   * Preflight validation rejects BEFORE anything is torn down: a malformed
   * selection, an unknown composition type (`CapabilityResolutionError`), a
   * composition the dataset does not support, or a multi-view layout on a
   * caller-owned canvas all leave the running scene untouched. Re-selecting
   * the CURRENT composition reapplies its config in place (a
   * portable-config-only change patches the live scene in ONE batched commit
   * instead of rebuilding). On an idle viewer (no dataset yet) the selection
   * is only recorded — resolution and validation are deferred to `open()` —
   * and the returned promise resolves immediately.
   */
  async setComposition(input: CompositionInput): Promise<void> {
    this._assertUsable("setComposition");
    const selection = normalizeCompositionInput(input, "viewer.setComposition");
    if (!this._dataset) {
      this._compositionSelection = selection; // intent recorded; resolved + validated on open
      return;
    }
    const dataset = this._dataset;
    const candidate = this._resolveComposition(selection, dataset);
    // Preflight (support + plan build + target) BEFORE any teardown.
    const { resolved, plan } = this._prepareComposition(
      candidate,
      dataset,
      this._effectiveChannels(
        candidate?.type ?? this._selectedCompositionType() ?? "slice",
        dataset,
      ),
      this._projection,
      candidate ? this._compositionOverrides[candidate.type]?.transform : undefined,
    );
    this._compositionSelection = selection;
    if (resolved.configInput !== undefined) {
      this._compositionConfigs.set(resolved.type, resolved.configInput);
    }
    if (
      this._resolved && this._resolved.type === resolved.type &&
      this._pendingType === resolved.type
    ) {
      // Same composition, no other transition in flight: reapply (a
      // config-only change patches in place).
      await this._applyPlanUpdate(resolved, plan);
      return;
    }
    if (resolved.type === this._pendingType && resolved.configInput === undefined) {
      return; // already the latest intent
    }
    this._pendingType = resolved.type;
    const revision = ++this._revision;
    const op = this._rebuild(revision, resolved, plan, this._focus);
    this._track(op);
    await op;
  }

  /**
   * Merge portable config into the current composition and reapply it. When
   * only portable layer state changed (e.g. a grid page turn), the new plan
   * applies WITHOUT an runtime rebuild — ONE batched `updateLayers` commit.
   * A structural change (e.g. a grid `pool` change) falls back to a full
   * (revisioned, supersession-aware) transition. On an idle viewer the config
   * is recorded and applied at open.
   */
  async setCompositionConfig(config: JsonObject): Promise<void> {
    this._assertUsable("setCompositionConfig");
    const validated = validateJsonObject(config, "viewer.setCompositionConfig");
    const type = this._resolved?.type ?? this._selectedCompositionType();
    if (type === undefined) {
      throw new Error(
        "viewer.setCompositionConfig: no composition is selected — pass an explicit composition " +
        "to createViewer / viewer.setComposition before configuring it",
      );
    }
    const merged = { ...this._compositionConfigs.get(type), ...validated };
    if (!this._runtime || !this._dataset || !this._resolved || this._resolved.type !== type) {
      // Recorded only — applied at the next build.
      this._compositionConfigs.set(type, merged);
      return;
    }
    const resolved = this._resolved;
    // Build against the candidate config WITHOUT committing it: a rejected
    // build (e.g. an invalid grid pool) leaves the stored config untouched.
    const plan = this._buildPlan(
      resolved,
      this._dataset,
      this._effectiveChannels(type, this._dataset),
      this._projection,
      this._compositionOverrides[type]?.transform,
      merged,
    );
    await this._applyPlanUpdate(resolved, plan);
  }

  /**
   * Reapply a freshly built plan for the CURRENT composition: a compatible
   * plan (same layout/views/layer set/runtime data) patches the live scene in
   * ONE batched commit; a structural change falls back to a full transition.
   */
  private async _applyPlanUpdate(
    resolved : ResolvedComposition,
    plan     : CompositionPlan,
  ): Promise<void> {
    const current = this._resolved!;
    const runtime = this._runtime!;
    if (plansCompatible(current.plan, plan)) {
      const patches = diffPlanLayers(runtime.getState().layers ?? [], plan);
      if (patches.length > 0) runtime.updateLayers(patches); // ONE commit per batch
      if (plan.config !== undefined) this._compositionConfigs.set(resolved.type, plan.config);
      this._resolved = { ...resolved, plan };
      this._notifyState();
      return;
    }
    const revision = ++this._revision;
    this._pendingType = resolved.type;
    const op = this._rebuild(revision, resolved, plan, this._focus);
    this._track(op);
    await op;
  }

  // === Channels ===

  /**
   * Channel-level access — one operation per channel, no layer-ID scans.
   * The channel's config maps to the composition plan's channel bindings.
   */
  channel(index: number): ViewerChannelAccessor {
    this._assertUsable("channel");
    if (!this._dataset) {
      throw new Error("viewer.channel(): no dataset open — call viewer.open() first");
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
      get config(): ChannelState {
        const channel = self._effectiveChannels(self._resolved?.type ?? "slice")
          .find((c) => c.index === index)!;
        return { ...channel, contrast: [...channel.contrast] as [number, number] };
      },
      configure(patch: ViewerChannelPatch): void {
        const normalized = normalizeChannelPatch(patch, `viewer.channel(${index}).configure`);
        self._channelOverrides.set(index, { ...self._channelOverrides.get(index), ...normalized });
        // Edit-what-you-see: when the ACTIVE composition carries its own
        // channel override (compositions[type]), a base-only edit would be
        // masked by it in the live apply. Merge the patch into the active
        // composition's override too, so the edit takes effect immediately and
        // `viewer.getState()` mirrors what the user sees.
        const type = self._resolved?.type;
        const overrideChannels = type ? self._compositionOverrides[type]?.channels : undefined;
        if (type && overrideChannels?.some((c) => c.index === index)) {
          self._compositionOverrides[type] = {
            ...self._compositionOverrides[type],
            channels: overrideChannels.map((c) => (c.index === index ? { ...c, ...normalized } : c)),
          };
        }
        self._applyChannelLive(index);
      },
    };
  }

  /** Every channel's effective config (dataset defaults + overrides + active composition override). */
  get channels(): ChannelState[] {
    if (!this._dataset) return [];
    return this._effectiveChannels(this._resolved?.type ?? "slice")
      .map((c) => ({ ...c, contrast: [...c.contrast] as [number, number] }));
  }

  // === Projection ===

  /** Volume accumulation projection — maps to `render.volumeProjection` on volume layers. */
  set projection(value: ViewerProjection) {
    this._assertUsable("projection");
    assertProjection(value);
    this._projection = value;
    const runtime = this._runtime;
    const resolved = this._resolved;
    if (!runtime || !resolved) return;
    const patches: LayerPatch[] = resolved.plan.bindings.projectionLayers.map((id) => ({
      id,
      render: { volumeProjection: value },
    }));
    if (patches.length > 0) runtime.updateLayers(patches);
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
    if (!this._runtime) return;
    if (normalized === "fit") {
      this.fitCamera();
      return;
    }
    const state = this._runtime.getState();
    state.exploration.camera = mergeCamera(state.exploration.camera, normalized);
    this._runtime.setState(state);
  }

  /** Reframe the dataset bounds for the current composition via the existing fit helpers. */
  fitCamera(): void {
    this._assertUsable("fitCamera");
    if (!this._runtime || !this._resolved || !this._dataset) return;
    const state = this._runtime.getState();
    state.exploration.camera = this._fitCamera(this._resolved.plan);
    this._runtime.setState(state);
  }

  /**
   * Move the slice position of the active slice/quad composition: every slice
   * plane in the plan's bindings shows the slice at `point` along its through
   * axis, and the camera focus is translated onto `point` (position↔target
   * offset preserved, same as composition transitions). No-op before open or
   * when the plan declares no slice planes (volume, and the config-driven grid).
   */
  setSlicePoint(point: Vec3): void {
    this._assertUsable("setSlicePoint");
    const runtime = this._runtime;
    const resolved = this._resolved;
    if (!runtime || !resolved) return;
    if (resolved.plan.bindings.slicePlanes.length === 0) return;
    this._syncSliceLayers(resolved.plan, point);
    const state = runtime.getState();
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
    runtime.setState(state);
    this._focus = [...point] as Vec3;
  }

  // === Controls and tools ===

  /**
   * Runtime control access with the same typed options as the declarative
   * `controls` key. Controls are creation-only at the low level; the Viewer
   * re-instantiates the view's control chain through the control registry so
   * declarative and imperative paths agree.
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
   * magnifier-2d/3d) attached to the current composition's views.
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
        assertSerializableToolOptions(
          name,
          options as Record<string, unknown>,
          `viewer.tool("${name}").configure`,
        );
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
        // is required); enabling it fresh uses `{}` — view-type-default dimension.
        tools[name] = (enabled
          ? (prev === undefined || prev === false ? (name === "magnifier" ? {} : true) : prev)
          : false) as never;
        self._toolsConfig = tools;
        self._applyToolLive(name);
      },
    };
  }

  // === Per-composition overrides ===

  /**
   * Imperative equivalent of `compositions[type]`: merge per-composition
   * overrides; applies immediately (with focus preservation) when that
   * composition is the active one.
   */
  composition(type: string): ViewerCompositionAccessor {
    this._assertUsable("composition");
    if (typeof type !== "string" || type.length === 0 || type === "auto") {
      throw new Error(
        `viewer.composition: type must be a concrete composition type string, got ${JSON.stringify(type)}`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      configure(value: ViewerCompositionOverride): void {
        const normalized = normalizeCompositionOverrides(
          { [type]: value },
          `viewer.composition("${type}")`,
        )[type] ?? {};
        const prev = self._compositionOverrides[type] ?? {};
        const next: ViewerCompositionOverride = { ...prev };
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
        self._compositionOverrides[type] = next;
        if (self._dataset && self._resolved?.type === type) self._reenter();
      },
    };
  }

  // === Events ===

  /**
   * Subscribe to a high-level Viewer runtime event — the typed
   * counterpart of the low-level overlay callbacks. Returns an unsubscribe
   * function. One overlay change produces exactly one event, carrying the
   * interacting view's id and the composition in effect. Subscriptions live on
   * the Viewer, so they survive open/composition rebuilds; `destroy()` clears
   * them.
   */
  on<K extends ViewerEventName>(
    name    : K,
    handler : (event: ViewerEventMap[K]) => void,
  ): () => void {
    this._assertUsable("on");
    assertEventName(name);
    if (typeof handler !== "function") {
      throw new Error(`viewer.on("${name}"): handler must be a function, got ${typeof handler}`);
    }
    const handlers = this._eventHandlers[name] as Set<(event: ViewerEventMap[K]) => void>;
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  // === Teardown ===

  /** Destroy the low-level instance, dispose the dataset, detach viewer-owned DOM, supersede in-flight work. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._revision; // supersede any in-flight open/transition
    for (const handlers of Object.values(this._eventHandlers)) handlers.clear();
    this._stateListeners.clear();
    this._teardownRuntime();
    this._dataset?.dispose();
    this._dataset = undefined;
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

  private _teardownRuntime(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    const runtime = this._runtime;
    this._runtime = undefined;
    this._liveOverlays.clear();
    runtime?.destroy();
  }

  // === Composition resolution + preflight ===

  /** The composition type named by the current selection (undefined for unresolved "auto"). */
  private _selectedCompositionType(): string | undefined {
    const selection = this._compositionSelection;
    if (selection === "auto") return undefined;
    if ("implementation" in selection) {
      return selection.reference?.type ?? selection.implementation.type;
    }
    return selection.type;
  }

  /**
   * Resolve a composition selection against a dataset: `"auto"` runs the
   * auto policy (undefined when nothing supports it), a reference resolves
   * through the composition registry (`CapabilityResolutionError` on a miss),
   * a direct implementation bypasses the registry. Pure — nothing is
   * committed here.
   */
  private _resolveComposition(
    selection : CompositionInput,
    dataset   : Dataset,
  ): ResolvedComposition | undefined {
    ensureBuiltInCompositions();
    if (selection === "auto") {
      const type = resolveAutoComposition(dataset);
      if (type === undefined) return undefined;
      return { type, implementation: resolveComposition(type), reference: { type } };
    }
    if ("implementation" in selection) {
      const type = selection.reference?.type ?? selection.implementation.type;
      return {
        type,
        implementation : selection.implementation,
        reference      : selection.reference
          ? { type: selection.reference.type }
          : undefined,
        ...(selection.reference?.config !== undefined
          ? { configInput: selection.reference.config }
          : {}),
      };
    }
    return {
      type           : selection.type,
      implementation : resolveComposition(selection.type),
      reference      : { type: selection.type },
      ...(selection.config !== undefined ? { configInput: selection.config } : {}),
    };
  }

  /** The input handed to `composition.build(...)` for `type`. */
  private _buildInput(
    type      : string,
    dataset   : Dataset,
    channels  : ChannelState[] = this._effectiveChannels(type, dataset),
    projection: ViewerProjection = this._projection,
    transform : number[] | undefined = this._compositionOverrides[type]?.transform,
    config    : JsonObject | undefined = this._compositionConfigs.get(type),
  ): CompositionBuildInput {
    return {
      dataset,
      channels,
      projection,
      ...(transform !== undefined ? { transform } : {}),
      ...(config !== undefined ? { config } : {}),
    };
  }

  private _buildPlan(
    resolved   : ResolvedComposition,
    dataset    : Dataset,
    channels   : ChannelState[],
    projection : ViewerProjection,
    transform  : number[] | undefined,
    config?    : JsonObject,
  ): CompositionPlan {
    return resolved.implementation.build(
      this._buildInput(resolved.type, dataset, channels, projection, transform, config),
    );
  }

  /**
   * Whether the target layout can host `plan`: a caller-owned canvas is a
   * single view — multi-view layouts need the Viewer to own the DOM.
   */
  private _targetSupportsPlan(plan: CompositionPlan): boolean {
    return Object.keys(plan.views).length === 1 || this._target.kind !== "canvas";
  }

  /**
   * Preflight a resolved composition against a dataset: support check, plan
   * build, and target-layout check — all BEFORE any teardown, so a rejected
   * transition leaves the running scene (and the recorded intent) untouched.
   */
  private _prepareComposition(
    candidate  : ResolvedComposition | undefined,
    dataset    : Dataset,
    channels   : ChannelState[],
    projection : ViewerProjection,
    transform  : number[] | undefined,
  ): { resolved: ResolvedComposition; plan: CompositionPlan } {
    if (candidate === undefined || !candidate.implementation.supports(dataset)) {
      const supported = supportedCompositions(dataset);
      if (supported.length === 0) {
        const resources = dataset.resources
          .map((resource) => `"${resource.kind}" "${resource.id}"`)
          .join(", ") || "none";
        throw new Error(
          `No registered composition supports dataset kind "${dataset.type}" ` +
          `(resources: ${resources}). The built-in compositions present image-pyramid ` +
          "and mesh primary resources; register a custom composition via " +
          "registerComposition() or drive the dataset through createViewerRuntime.",
        );
      }
      throw new Error(
        `Composition "${candidate?.type ?? "auto"}" is not supported by dataset kind "${dataset.type}" ` +
        `(available: ${supported.join(", ")}). ` +
        "Check viewer.availableCompositions before transitioning.",
      );
    }
    const plan = this._buildPlan(
      candidate, dataset, channels, projection, transform, candidate.configInput,
    );
    if (!this._targetSupportsPlan(plan)) {
      throw new Error(
        `Composition "${candidate.type}" requires a container element (the Viewer lays out ` +
        `${Object.keys(plan.views).length} canvases); ` +
        "pass a container to createViewer instead of a canvas",
      );
    }
    return { resolved: candidate, plan };
  }

  /**
   * Rebuild the low-level scene: destroy the current ViewerRuntime, translate
   * the viewer state into a fresh ViewerRuntimeConfig, and delegate
   * creation/mounting to `createViewerRuntime`. `focus` is the physical point
   * to preserve (composition transitions); undefined fits the dataset bounds.
   * `exactCamera` (setState restores) applies verbatim — it bypasses the
   * declared-camera/focus merge so the live viewpoint restores exactly.
   */
  private async _rebuild(
    revision    : number,
    resolved    : ResolvedComposition,
    plan        : CompositionPlan,
    focus       : Vec3 | undefined,
    exactCamera?: Camera,
  ): Promise<void> {
    this._status = "loading";
    this._teardownRuntime();

    let runtime: ViewerRuntime;
    let config: ViewerRuntimeConfig;
    try {
      const canvases = this._ensureCanvases(resolved, plan);
      config = this._buildViewerRuntimeConfig(resolved, plan, canvases, focus, exactCamera);
      runtime = await createViewerRuntime(config);
    } catch (err) {
      if (this._isCurrent(revision)) {
        this._error = err;
        this._status = "error";
      }
      throw err;
    }
    this._assertCurrent(revision, "composition transition", () => runtime.destroy());
    this._runtime = runtime;
    this._resolved = { ...resolved, plan };
    this._pendingType = resolved.type;
    // The normalized plan config is the canonical portable form.
    if (plan.config !== undefined) this._compositionConfigs.set(resolved.type, plan.config);
    this._focus = [...runtime.getState().exploration.camera.target] as Vec3;
    this._unsubscribe = runtime.subscribe((state) => {
      this._focus = [...state.exploration.camera.target] as Vec3;
    });
    // Zip the built overlay keys onto the live instances (createView
    // instantiates in Object.entries order).
    for (const [id, viewConfig] of Object.entries(config.views)) {
      const keys = Object.keys(viewConfig.overlays ?? {});
      const instances = runtime.view(id).base.getOverlays();
      const byType = new Map<string, BaseOverlay>();
      keys.forEach((type, i) => byType.set(type, instances[i]));
      this._liveOverlays.set(id, byType);
      // Forward ROI overlay changes to the Viewer event surface.
      const roiOverlay = byType.get("roiselector");
      if (roiOverlay) this._wireRoiOverlay(roiOverlay, id);
    }

    runtime.setActiveView(plan.activeViewId);

    // Slice layers default to the center slice; a preserved focus must show
    // the slice AT the focus (focus preservation covers what is shown, not
    // just where the camera looks).
    if (focus) this._syncSliceLayers(plan, focus);

    // Await structural readiness of every unique generated layer
    // before reporting ready, through every view that references one (a
    // multi-view composition's layers live across its views — the active
    // view alone does not see them all). Tiled layers resolve immediately —
    // readiness means source/pyramid available, NOT full tile refinement.
    // Source-backed layers (e.g. surfaces) settle once fetched/parsed, and a
    // source failure rejects with the recorded load error.
    try {
      await awaitConfiguredLayersReady(runtime, config.views);
    } catch (err) {
      // A superseded rebuild's waiters reject on runtime teardown — the
      // supersession error wins over the teardown reason.
      this._assertCurrent(revision, "composition transition", () => runtime.destroy());
      this._error = err;
      this._status = "error";
      throw err;
    }
    this._assertCurrent(revision, "composition transition");
    this._error = undefined;
    this._status = "ready";
    // Exactly one committed-snapshot notification per successful rebuild
    // (open / composition transition / setState) — never one per field.
    this._notifyState();
  }

  /** Re-apply the current composition (an override change on the active composition). */
  private _reenter(): void {
    const resolved = this._resolved;
    if (!resolved || !this._dataset) return;
    const revision = ++this._revision;
    const plan = this._buildPlan(
      resolved,
      this._dataset,
      this._effectiveChannels(resolved.type, this._dataset),
      this._projection,
      this._compositionOverrides[resolved.type]?.transform,
    );
    this._track(this._rebuild(revision, resolved, plan, this._focus));
  }

  // === Event internals ===

  private _emit<K extends ViewerEventName>(name: K, event: ViewerEventMap[K]): void {
    const handlers = this._eventHandlers[name] as Set<(event: ViewerEventMap[K]) => void>;
    for (const handler of handlers) handler(event);
  }

  /**
   * Attach the ROI event forwarders to a live roiselector overlay.
   * Runs on every scene rebuild and on runtime tool attach, so Viewer-level
   * subscriptions keep firing across runtime rebuilds. The overlay only ever
   * sees the forwarders — user callbacks never enter the overlay options
   * through the high-level surface. View/composition identity resolves at
   * event time. Edits mirror into the high-level tool state BEFORE the Viewer
   * event emits, so `viewer.getState()` reflects the ROI data by the time
   * handlers run.
   */
  private _wireRoiOverlay(overlay: BaseOverlay, viewId: string): void {
    overlay.setOptions({
      onRoisChange: (rois: RoiBox[], change: RoiSelectionChange) => {
        const composition = this._resolved?.type;
        if (!composition) return;
        this._mirrorRoiToTools({ rois });
        this._emit("roiChange", { rois, change, viewId, composition });
      },
      onActiveIndexChange: (activeIndex: number | null) => {
        const composition = this._resolved?.type;
        if (!composition) return;
        this._mirrorRoiToTools({ activeIndex });
        this._emit("roiActiveChange", { activeIndex, viewId, composition });
      },
    });
  }

  /**
   * Mirror an ROI overlay change into the tool state the overlay was
   * configured from: the active composition's override when it declares the
   * roi tool, else the base tools config — so `getState().tools.roi` carries
   * the current editable ROI data and active selection. A bare `true` enable
   * becomes an options bag once edits exist.
   */
  private _mirrorRoiToTools(patch: { rois?: RoiBox[]; activeIndex?: number | null }): void {
    const type = this._resolved?.type;
    if (!type) return;
    const merge = (prev: boolean | ViewerRoiOptions | undefined): ViewerRoiOptions => {
      const next: ViewerRoiOptions = prev && typeof prev === "object" ? { ...prev } : {};
      if (patch.rois !== undefined) {
        next.rois = patch.rois.map((roi) => ({
          min: [...roi.min] as Vec3,
          max: [...roi.max] as Vec3,
        }));
      }
      if (patch.activeIndex !== undefined) next.activeIndex = patch.activeIndex;
      return next;
    };
    const overrideTools = this._compositionOverrides[type]?.tools;
    if (overrideTools && overrideTools.roi !== undefined) {
      overrideTools.roi = merge(overrideTools.roi);
      return;
    }
    const tools = { ...(this._toolsConfig ?? {}) };
    tools.roi = merge(tools.roi);
    this._toolsConfig = tools;
  }

  /**
   * The portable tool VALUES for `State.tools`: today only the ROI tool
   * carries portable values (selections + active index), extracted from the
   * live tools config. Tool OPTIONS (enabled flags, overlay settings) stay in
   * `ViewerConfig` — they are viewer-local presentation preferences.
   */
  private _toolStateValues(): Record<string, JsonValue> | undefined {
    const roi = this._toolsConfig?.roi;
    if (roi === undefined || typeof roi !== "object") return undefined;
    const values: JsonObject = {};
    if (roi.rois !== undefined) values.rois = roi.rois as unknown as JsonValue;
    if (roi.activeIndex !== undefined) values.activeIndex = roi.activeIndex ?? null;
    return Object.keys(values).length > 0 ? { roi: values } : undefined;
  }

  /**
   * Merge portable tool VALUES (`State.tools`) into the tools config so the
   * rebuilt overlays show them. Tool names are checked semantically here
   * (structural JSON-safety was already enforced by `validateState`).
   */
  private _toolsConfigWithValues(values: Record<string, JsonValue>): ViewerToolsConfig {
    const tools: ViewerToolsConfig = { ...(this._toolsConfig ?? {}) };
    for (const [name, value] of Object.entries(values)) {
      assertToolName(name);
      if (name !== "roi") continue; // no other portable tool values today
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`state.tools.${name} must be an object of tool values, got ${JSON.stringify(value)}`);
      }
      const prev = tools.roi;
      tools.roi = {
        ...(prev && typeof prev === "object" ? prev : {}),
        ...(value as JsonObject),
      } as ViewerRoiOptions;
    }
    return tools;
  }

  // === Translation ===

  private _requireDataset(): Dataset {
    if (!this._dataset) throw new Error("No dataset open — call viewer.open() first");
    return this._dataset;
  }

  /**
   * Effective channels for a composition type: dataset defaults + base
   * overrides + the per-composition override. The override sources default to
   * the live ones; `setState` preflight passes its candidate values.
   */
  private _effectiveChannels(
    type              : string,
    dataset           : Dataset = this._requireDataset(),
    channelOverrides  : Map<number, ViewerChannelPatch> = this._channelOverrides,
    compositionOverrides: Record<string, ViewerCompositionOverride> = this._compositionOverrides,
  ): ChannelState[] {
    const base: ChannelState[] = dataset.channels.map((channel) => {
      const patch = channelOverrides.get(channel.index) ?? {};
      return {
        index    : channel.index,
        label    : patch.label ?? channel.label,
        visible  : patch.visible ?? channel.visible,
        color    : patch.color ?? channel.color,
        contrast : (patch.contrast ?? channel.contrast) as [number, number],
      };
    });
    const override = compositionOverrides[type]?.channels;
    if (!override || override.length === 0) return base;
    const patches = new Map<number, ViewerChannelPatch>();
    for (const entry of override) {
      patches.set(entry.index, {
        ...patches.get(entry.index),
        ...normalizeChannelPatch(entry, `compositions.${type}.channels`),
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

  /**
   * Push the slice containing `point` into every slice plane of the plan's
   * bindings (per-plane through axis, clamped to the layer's own range by the
   * layer). Slice layers default to the center slice, so composition entry
   * with a preserved focus and explicit `setSlicePoint` calls both go through
   * here.
   */
  private _syncSliceLayers(plan: CompositionPlan, point: Vec3): void {
    const runtime = this._runtime;
    if (!runtime) return;
    const dataset = this._requireDataset();
    const spatial = dataset.physical?.spatial;
    const spacing = spatial?.spacing ?? [1, 1, 1];
    const origin = spatial?.origin ?? [0, 0, 0];
    for (const plane of plan.bindings.slicePlanes) {
      const through = plane.axes[2];
      const index = Math.round((point[through] - origin[through]) / spacing[through]);
      for (const layerId of plane.layerIds) {
        runtime.layer(layerId)?.setOptions({ sliceIndex: index });
      }
    }
  }

  private _controlsFor(type: string, viewType: string): ControlOptions {
    const declared = this._compositionOverrides[type]?.controls ?? this._controlsConfig;
    if (declared !== undefined) return expandViewerControls(declared);
    return (viewType === "volume" ? { orbit: {} } : { panzoom: {} }) as ControlOptions;
  }

  private _overlaysFor(type: string, viewType: string): OverlayOptions {
    const tools = this._compositionOverrides[type]?.tools ?? this._toolsConfig;
    return expandViewerTools(tools, viewType);
  }

  /**
   * Fit framing for a plan: a composition with a volume view frames the
   * volume bounds; slice-only plans (slice, grid) fit the x/y plane.
   */
  private _fitCamera(plan: CompositionPlan): Camera {
    const physical = this._requireDataset().physical ?? DEFAULT_PHYSICAL;
    const hasVolumeView = Object.values(plan.views).some((view) => view.type === "volume");
    return hasVolumeView
      ? frameVolumeCamera(physical)
      : fitSliceCamera([0, 1, 2], physical);
  }

  /**
   * Camera for entering a composition: the plan's fit framing, merged with
   * the declared camera (base config, then the per-composition override),
   * then translated onto the preserved physical focus. An explicit `target`
   * wins over the preserved focus; an override of `camera: "fit"` forces a
   * re-fit (drops the preserved focus).
   */
  private _cameraFor(type: string, plan: CompositionPlan, focus: Vec3 | undefined): Camera {
    const fit = this._fitCamera(plan);
    const overrideCamera = this._compositionOverrides[type]?.camera;
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

  private _buildViewerRuntimeConfig(
    resolved    : ResolvedComposition,
    plan        : CompositionPlan,
    canvases    : Record<string, HTMLCanvasElement>,
    focus       : Vec3 | undefined,
    exactCamera?: Camera,
  ): ViewerRuntimeConfig {
    const dataset = this._requireDataset();
    const channels = this._effectiveChannels(resolved.type, dataset);
    const physical: PhysicalSpace = {
      ...(dataset.physical ?? DEFAULT_PHYSICAL),
      channels: { names: channels.map((c) => c.label) },
    };

    // The scene comes from the plan: the Viewer adds the host canvases and
    // the per-view controls/tools plumbing; layer wiring is the plan's.
    const views: Record<string, ViewConfig> = {};
    for (const [id, view] of Object.entries(plan.views)) {
      views[id] = {
        ...view,
        canvas   : canvases[id],
        controls : this._controlsFor(resolved.type, view.type),
        overlays : this._overlaysFor(resolved.type, view.type),
        ...(view.type === "volume" && this._autoRotate ? { autoRotate: this._autoRotate } : {}),
      };
    }

    return {
      state: {
        physical,
        layers: plan.layers,
        exploration: { camera: exactCamera ?? this._cameraFor(resolved.type, plan, focus) },
      },
      views,
      ...(this._theme ? { theme: this._theme } : {}),
    };
  }

  // === Live application (imperative paths) ===

  private _applyChannelLive(index: number): void {
    const runtime = this._runtime;
    const resolved = this._resolved;
    if (!runtime || !resolved || !this._dataset) return;
    // Rebuild the (pure) plan with the updated channels and patch exactly the
    // channel's bound layers — the plan recomputes per-cell visibility for
    // config-driven compositions (grid hidden cells stay hidden).
    const plan = this._buildPlan(
      resolved,
      this._dataset,
      this._effectiveChannels(resolved.type, this._dataset),
      this._projection,
      this._compositionOverrides[resolved.type]?.transform,
    );
    const planById = new Map(plan.layers.map((layer) => [layer.id, layer]));
    const patches: LayerPatch[] = [];
    for (const id of resolved.plan.bindings.channels.get(index) ?? []) {
      const next = planById.get(id);
      if (!next) continue;
      patches.push({ id, render: { ...next.render } });
    }
    if (patches.length > 0) runtime.updateLayers(patches); // ONE commit per channel edit
    this._resolved = { ...resolved, plan };
    // Channel labels live in the shared physical space — commit only on change.
    const names = this._effectiveChannels(resolved.type).map((c) => c.label);
    const state = runtime.getState();
    if (state.physical?.channels && !jsonEquals(state.physical.channels.names, names)) {
      state.physical = {
        ...state.physical,
        channels: {
          ...state.physical.channels,
          names,
        },
      };
      runtime.setState(state);
    }
  }

  private _applyControlsLive(): void {
    const runtime = this._runtime;
    const resolved = this._resolved;
    if (!runtime || !resolved) return;
    for (const [id, view] of Object.entries(resolved.plan.views)) {
      const options = this._controlsFor(resolved.type, view.type);
      const controls: BaseControl[] = [];
      for (const [type, opts] of Object.entries(options)) {
        if (!opts) continue;
        controls.push(controlRegistry.resolve(type)(`viewer-${id}-${type}`, opts as Record<string, unknown>));
      }
      runtime.view(id).base.setControls(controls);
    }
  }

  private _applyToolLive(name: ViewerToolName): void {
    const runtime = this._runtime;
    const resolved = this._resolved;
    if (!runtime || !resolved) return;
    for (const [id, view] of Object.entries(resolved.plan.views)) {
      const desired = this._overlaysFor(resolved.type, view.type);
      const base = runtime.view(id).base;
      const live = this._liveOverlays.get(id) ?? new Map<string, BaseOverlay>();
      this._liveOverlays.set(id, live);
      for (const type of toolOverlayTypes(name)) {
        const existing = live.get(type);
        const options = desired[type];
        if (options) {
          if (existing) {
            existing.setOptions(options);
          } else {
            const overlay: BaseOverlay = overlayRegistry.resolve(type)();
            overlay.setOptions(options);
            base.addOverlay(overlay);
            live.set(type, overlay);
            // Forward ROI overlay changes to the Viewer event surface.
            if (type === "roiselector") this._wireRoiOverlay(overlay, id);
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
    runtime.requestRender();
  }

  private _defaultControlsConfig(): ViewerControlsConfig {
    const plan = this._resolved?.plan;
    const viewTypes = new Set(Object.values(plan?.views ?? {}).map((view) => view.type));
    const config: ViewerControlsConfig = {};
    if (viewTypes.has("slice")) config.panzoom = true;
    if (viewTypes.has("volume")) config.orbit = true;
    if (viewTypes.size === 0) config.panzoom = true; // pre-open fallback
    return config;
  }

  private _isControlEnabled(name: ViewerControlName): boolean {
    const type = this._resolved?.type;
    if (!type) return false;
    const declared = this._compositionOverrides[type]?.controls ?? this._controlsConfig;
    if (declared !== undefined) {
      const value = declared[name];
      return value !== undefined && value !== false;
    }
    const defaults = this._defaultControlsConfig();
    return defaults[name] !== undefined && defaults[name] !== false;
  }

  private _isToolEnabled(name: ViewerToolName): boolean {
    const type = this._resolved?.type;
    if (!type) return false;
    const tools = this._compositionOverrides[type]?.tools ?? this._toolsConfig;
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

  private _ensureCanvases(
    resolved : ResolvedComposition,
    plan     : CompositionPlan,
  ): Record<string, HTMLCanvasElement> {
    const viewIds = Object.keys(plan.views);
    if (this._target.kind === "canvas") {
      if (viewIds.length > 1) {
        throw new Error(
          `Composition "${resolved.type}" requires a container element (the Viewer lays out ` +
          `${viewIds.length} canvases); ` +
          "pass a container to createViewer instead of a canvas",
        );
      }
      return { [viewIds[0]]: this._target.canvas };
    }
    const container = this._target.container;
    if (viewIds.length > 1) {
      this._removeSingleCanvas();
      // One viewer-owned multi-canvas host: the 2×2 quad layout, or the paged
      // grid layout (a square-ish canvas pool). Rebuilt when the view set or
      // layout kind changes (e.g. a grid pool resize).
      const columns = plan.layout.kind === "quad" ? 2 : Math.ceil(Math.sqrt(viewIds.length));
      const rows = Math.ceil(viewIds.length / columns);
      const key = `${plan.layout.kind}:${viewIds.join(",")}`;
      if (!this._multiHost || this._multiHost.key !== key) {
        this._removeMultiHost();
        const doc = this._ownerDocument(container);
        const grid = doc.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
        grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
        grid.style.width = "100%";
        grid.style.height = "100%";
        const canvases: Record<string, HTMLCanvasElement> = {};
        for (const id of viewIds) {
          const canvas = doc.createElement("canvas");
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.display = "block";
          grid.appendChild(canvas);
          canvases[id] = canvas;
        }
        container.appendChild(grid);
        this._multiHost = { el: grid, canvases, key };
      }
      return this._multiHost.canvases;
    }
    this._removeMultiHost();
    if (!this._singleCanvas) {
      const doc = this._ownerDocument(container);
      const canvas = doc.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      container.appendChild(canvas);
      this._singleCanvas = canvas;
    }
    return { [viewIds[0]]: this._singleCanvas };
  }

  private _removeSingleCanvas(): void {
    if (this._singleCanvas?.parentNode) {
      this._singleCanvas.parentNode.removeChild(this._singleCanvas);
    }
    this._singleCanvas = undefined;
  }

  private _removeMultiHost(): void {
    if (this._multiHost?.el.parentNode) {
      this._multiHost.el.parentNode.removeChild(this._multiHost.el);
    }
    this._multiHost = undefined;
  }

  private _removeOwnedDom(): void {
    this._removeSingleCanvas();
    this._removeMultiHost();
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a high-level Viewer on a selector, container, or canvas.
 *
 * - Selector / container: the Viewer creates and owns its canvases inside the
 *   container (one per plan view — a 2×2 grid for `quad`, a canvas pool for
 *   `grid`).
 * - Canvas: framework ownership — the Viewer renders into it (multi-view
 *   compositions are unavailable; they need to own the layout).
 *
 * With `config.dataset`, the returned promise resolves only once the dataset
 * is open and ready; load failures reject with the actionable cause
 *. With `config.state`, the document restores through the
 * same preflight-before-teardown path as `viewer.setState`. Without either,
 * the viewer starts `idle` — call `await viewer.open(config)`.
 *
 * Creation is transactional: when the initial open/restore rejects, the
 * never-returned viewer is destroyed first — viewer-owned DOM removed from
 * the container, the runtime's GPU device released, the opened dataset
 * disposed — so a failed creation leaves nothing the caller cannot reach. The
 * original error is rethrown unchanged; cleanup failures never mask it.
 */
export async function createViewer(
  element : string | HTMLElement | HTMLCanvasElement,
  config  : ViewerConfig = {},
): Promise<Viewer> {
  const viewer = new Viewer(resolveTarget(element), config);
  try {
    if (config.state !== undefined) {
      await viewer.setState(config.state);
    } else if (config.dataset) {
      await viewer.open(config.dataset);
    }
  } catch (err) {
    try {
      viewer.destroy();
    } catch {
      // The setup failure wins — cleanup noise is swallowed, never rethrown.
    }
    throw err;
  }
  return viewer;
}
