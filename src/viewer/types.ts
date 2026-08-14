/**
 * High-level Viewer config types (DX-L1).
 *
 * `ViewerConfig` is the minimal, JSON-serializable schema for the common
 * scientific viewer (engineering-cleanup-plan.md §15.2). Runtime event
 * handlers, custom fetch functions, and plugin instances are imperative
 * runtime concerns and never appear here; every key has an imperative
 * equivalent with identical validation and default merging (§15.4).
 */

import type { Camera, SourceDescriptor, VolumeRenderMode } from "../types";
import type { DeepPartial, GalaviTheme } from "../overlay/theme";
import type {
  FlyControlOptions,
  OrbitControlOptions,
  PanZoomControlOptions,
} from "../control";
import type {
  CrosshairOverlayOptions,
  MagnifierOverlayOptions,
  RoiSelectorOverlayOptions,
  RulerOverlayOptions,
} from "../overlay/options";

// ============================================================================
// VIEWER CONFIG
// ============================================================================

/**
 * Visualization mode. `"auto"` resolves deterministically per dataset
 * capabilities (§16): z=1 → slice; z>1 → volume when the dataset reports 3D
 * support and the automatic tile-budget policy (DX-M4) yields a valid bounded
 * preview; otherwise slice, with volume still exposed in
 * `viewer.availableModes`.
 */
export type ViewerMode = "auto" | "slice" | "volume" | "quad";

/** A concrete (non-auto) mode. */
export type ResolvedViewerMode = Exclude<ViewerMode, "auto">;

/** Volume ray-march accumulation — maps to low-level `render.volumeProjection` (DX-Q5). */
export type ViewerProjection = VolumeRenderMode;

/** Viewer load/transition status (DX-M2). */
export type ViewerStatus = "idle" | "loading" | "ready" | "error";

/** One channel's declarative config — the `viewer.channel(index)` counterpart (DX-M3). */
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
 * Declarative control set (DX-M6). `true` enables with defaults, an options
 * bag enables with those options, `false`/absent disables. When `controls` is
 * present it fully specifies the control set for the current mode's views;
 * when absent, the mode default applies (orbit for volume, panzoom for
 * slice; quad gets panzoom on the plane views and orbit on the 3D view).
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
 * Declarative tool set (DX-M6). Tools map to built-in overlays: crosshair →
 * `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier →
 * `"magnifier-2d"`/`"magnifier-3d"`. `true` enables with defaults, an options
 * bag enables with those options (same typed bag as the overlay), `false`/
 * absent disables. When `tools` is present it fully specifies the tool set.
 */
export interface ViewerToolsConfig {
  crosshair? : boolean | CrosshairOverlayOptions;
  ruler?     : boolean | RulerOverlayOptions;
  magnifier? : false | "2d" | "3d" | ViewerMagnifierOptions;
  roi?       : boolean | RoiSelectorOverlayOptions;
}

/**
 * Per-mode overrides applied when ENTERING that mode (scientifically
 * justified per-mode contrast/tools). Imperative equivalent:
 * `viewer.view(mode).configure(value)`. Overrides layer over the base config:
 * channels merge per index, camera/controls/tools replace the base value for
 * that mode's entries when present.
 */
export interface ViewerModeOverride {
  channels? : ViewerChannelConfig[];
  camera?   : ViewerCamera;
  controls? : ViewerControlsConfig;
  tools?    : ViewerToolsConfig;
  /**
   * Model transform for every layer CONSTRUCTED for this mode — a 4×4
   * column-major affine forwarded to each layer's `data.transform`. Because
   * it is layer config (not runtime mutation), it survives the Viewer's
   * open/mode-transition rebuilds by construction. Like the low-level
   * `data.transform`, it replaces the default physical-space scale/translate
   * (see `applyTransformConfig`), so the affine must encode the full
   * voxel→world mapping. Absent → the physical-space default.
   */
  transform? : number[];
}

export type ViewerModeOverrides = Partial<Record<ResolvedViewerMode, ViewerModeOverride>>;

/**
 * The minimal high-level viewer schema (§15.2). JSON-serializable by
 * contract: no callbacks, no runtime resources.
 */
export interface ViewerConfig {
  /** Dataset source descriptor; resolved via `openDataset` (DX-M1). */
  source?        : SourceDescriptor;
  /** Visualization mode (default `"auto"`). */
  mode?          : ViewerMode;
  /** Channel overrides over the dataset's normalized channels. */
  channels?      : ViewerChannelConfig[];
  /** Volume accumulation projection (default `"mip"`). */
  projection?    : ViewerProjection;
  /** Initial camera (default `"fit"` via the dataset bounds helpers). */
  camera?        : ViewerCamera;
  controls?      : ViewerControlsConfig;
  tools?         : ViewerToolsConfig;
  modeOverrides? : ViewerModeOverrides;
  /**
   * Overlay UI theme, merged over galavi's default theme and forwarded to the
   * underlying `createGalavi` call. Plain string bag — stays JSON-serializable.
   */
  theme?         : DeepPartial<GalaviTheme>;
  /**
   * Idle camera spin for volume views — forwarded to the generated volume
   * `ViewConfig.autoRotate`. Absent/false disables (the low-level default).
   */
  autoRotate?    : boolean | { speedDegPerSec?: number };
}

// ============================================================================
// IMPERATIVE ACCESSORS
// ============================================================================

/** Channel patch accepted by `viewer.channel(index).configure` (DX-M3). */
export type ViewerChannelPatch = Partial<Omit<ViewerChannelConfig, "index">>;

/** Fully-resolved channel state (dataset defaults + overrides). */
export interface ViewerChannelState {
  index    : number;
  label    : string;
  visible  : boolean;
  color    : string;
  contrast : [number, number];
}

/** `viewer.control(name)` handle (DX-M6). */
export interface ViewerControlAccessor<TOptions> {
  /** Whether the control is currently part of the active control set. */
  readonly enabled : boolean;
  /** Merge typed options and enable; same bag as the declarative key. */
  configure(options : Partial<TOptions>) : void;
  /** Enable (default options when never configured) or disable. */
  enable(enabled? : boolean) : void;
}

/** `viewer.tool(name)` handle (DX-M6). */
export interface ViewerToolAccessor<TOptions> {
  /** Whether the tool's overlay is currently attached and visible. */
  readonly enabled : boolean;
  /** Merge typed options and enable; same bag as the declarative key. */
  configure(options : Partial<TOptions>) : void;
  /** Enable (default options when never configured) or disable. */
  enable(enabled? : boolean) : void;
}

/** `viewer.channel(index)` handle (DX-M3). */
export interface ViewerChannelAccessor {
  /** Current effective channel state (dataset defaults + overrides). */
  readonly config : ViewerChannelState;
  /** Merge a channel patch; same validation/default merge as `channels[n]`. */
  configure(patch : ViewerChannelPatch) : void;
}

/** `viewer.view(mode)` handle — the imperative `modeOverrides[mode]` equivalent. */
export interface ViewerViewAccessor {
  /** Merge per-mode overrides; applies immediately when that mode is active. */
  configure(value : ViewerModeOverride) : void;
}

/** Typed control names and their option bags. */
export interface ViewerControlOptionsMap {
  orbit   : OrbitControlOptions;
  fly     : FlyControlOptions;
  panzoom : PanZoomControlOptions;
}
export type ViewerControlName = keyof ViewerControlOptionsMap;

/** Typed tool names and their option bags. */
export interface ViewerToolOptionsMap {
  crosshair : CrosshairOverlayOptions;
  ruler     : RulerOverlayOptions;
  magnifier : ViewerMagnifierOptions;
  roi       : RoiSelectorOverlayOptions;
}
export type ViewerToolName = keyof ViewerToolOptionsMap;
