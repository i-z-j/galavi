/**
 * Galavi Type Definitions
 */

import type { DeepPartial, GalaviTheme } from "./overlay/theme";
import type {
  FlyControlOptions,
  OrbitControlOptions,
  PanZoomControlOptions,
} from "./control";

// ============================================================================
// PRIMITIVES
// ============================================================================

export type ID   = string;
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type PhysicalUnit = 'nm' | 'µm' | 'mm' | 'cm' | 'm';

// ============================================================================
// GALAVI CONFIG
// ============================================================================

/**
 * Galavi configuration — everything needed to create a Galavi instance.
 *
 * Combines state (the WHAT) and view configurations (the HOW).
 * `await createGalavi(config)` inits GPU, mounts views, returns ready instance.
 */
export interface GalaviConfig {
  /** State — physical space, layers, exploration */
  state : State;
  /** View configurations keyed by view name */
  views : Record<string, ViewConfig>;
  /** Overlay UI theme override, merged over the default theme */
  theme?: DeepPartial<GalaviTheme>;
}

/**
 * State — the global sharable state.
 *
 * Three tiers by update frequency:
 * - physical: physical coordinate system, set once, rarely changes (optional)
 * - layers: data layer configurations, moderate updates
 * - exploration: navigation and interaction state, frequent updates
 *
 * This is what gets serialized and restored.
 */
export interface State {
  /** Physical coordinate system (optional — defaults to normalized [0,1]³ unitless space) */
  physical?     : PhysicalSpace;
  /** Ordered layer list (first = bottom, last = top) */
  layers        : LayerConfig[];
  /** Navigation and interaction state */
  exploration   : Exploration;
}

/**
 * Control option bags keyed by control type. The built-in control types
 * (orbit / fly / panzoom) carry their typed options; custom control types
 * registered via `registerControl` accept any options bag.
 */
export type ControlOptions = {
  [type: string]: Record<string, unknown> | undefined;
} & {
  orbit?   : OrbitControlOptions;
  fly?     : FlyControlOptions;
  panzoom? : PanZoomControlOptions;
};

/**
 * View configuration — defines a single view within a Galavi instance.
 * Views are keyed by name in `GalaviConfig.views`; the key is the view ID.
 */
export interface ViewConfig {
  /** View type */
  type          : string;
  /** Canvas element to render into. Omit for delayed mounting via galavi.mount(). */
  canvas?       : HTMLCanvasElement;
  /** Layers (IDs) to render in this view (must match IDs in state.layers) */
  layers        : ID[];
  /** Controls to attach, keyed by control type (e.g. { orbit: {}, fly: {} }) */
  controls?     : ControlOptions;
  /** Overlays to attach, keyed by overlay type (e.g. { crosshair: {}, ruler: { visible: false } }) */
  overlays?     : Record<string, Record<string, unknown>>;
  /** Human-readable label for this view */
  label?        : string;
  /** Whether this view can become the active view (default: true) */
  activatable?  : boolean;
  /**
   * Auto-rotate the unified camera (volume views). `true` spins at the default
   * speed; `{ speedDegPerSec }` overrides it. Stops permanently on the first
   * user input (mouse down / key down).
   */
  autoRotate?   : boolean | { speedDegPerSec?: number };
  /**
   * Automatically track canvas content-box resizes with a ResizeObserver and
   * re-render (default: true). The view owns the observer for the lifetime of
   * its canvas binding; set to `false` only when the host drives canvas pixel
   * sizing itself and wants no observer.
   */
  autoResize?   : boolean;
}

// ===========================================================================
// STATE
// =============================================================================

/**
 * PhysicalSpace — physical coordinate system and dataset metadata.
 *
 * All layers target the same physical space.
 */
export interface PhysicalSpace {
  /** Spatial configuration — maps voxel space to physical coordinates */
  spatial   : SpatialConfig;
  /** Temporal configuration for time-series data */
  temporal? : TemporalConfig;
  /** Channel configuration — authoritative channel definitions */
  channels? : ChannelConfig;
}

/**
 * Layer config — defines a data layer.
 *
 * `TOptions` types the `options` bag; per-layer aliases (e.g. `VolumeLayerConfig`,
 * `SliceLayerConfig`) wire each built-in layer's option interface, while plain
 * `LayerConfig` accepts any option bag.
 *
 * Config-boundary policy: unknown option keys are ignored, and a key whose
 * runtime value has the wrong type is treated as absent (the layer default
 * applies). Checked readers live in `utils/options.ts`.
 */
export interface LayerConfig<TOptions = Record<string, unknown>> {
  /** Layer ID */
  id        : ID;
  /** Layer type */
  type      : string;
  /** Data configuration */
  data?     : Data;
  /** Render configuration */
  render?   : Render;
  /** Type-specific options (includes selection: { c?, ... }) */
  options?  : TOptions;
}

/**
 * Exploration — navigation and interaction state.
 */
export interface Exploration {
  /** Camera position and orientation */
  camera    : Camera;
  /** Temporal navigation (omit if no time dimension) */
  temporal? : Temporal;
}

// ============================================================================
// PHYSICAL SPACE
// =============================================================================

/** Spatial configuration — maps voxel space to physical coordinates */
export interface SpatialConfig {
  /** Physical bounding box extent [x,y,z] (default [1,1,1], a.k.a [0,1]³ space) */
  size        : Vec3;
  /** Physical unit label (optional — unitless when omitted) */
  unit?       : PhysicalUnit | (string & {});
  /** Voxel size [x,y,z] in physical units (for resolution selection, ruler) */
  spacing?    : Vec3;
  /** Physical coordinate of voxel [0,0,0] (default [0,0,0]) */
  origin?     : Vec3;
  /** Optional global 4×4 affine matrix, column-major (rotation/shear from OME coordTransform) */
  transform?  : number[];
}

/** Temporal configuration — maps frame indices to physical time */
export interface TemporalConfig {
  /** Total number of timepoints */
  frameCount    : number;
  /** Physical time per frame in `unit` */
  frameInterval : number;
  /** Time offset of frame 0 (default 0) */
  startTime?    : number;
  /** Time unit (default 'second') */
  unit?         : 'second' | 'millisecond';
}

/** Channel configuration — authoritative channel definitions for the dataset */
export interface ChannelConfig {
  /** Channel names, e.g. ["DAPI", "GFP", "RFP"] */
  names         : string[];
  /** Emission wavelengths per channel (nm) */
  wavelengths?  : number[];
}

// ============================================================================
// LAYER
// ============================================================================

/**
 * One multiscale image level, normalized by an adapter into XYZ axis order.
 * Levels are ordered from finest to coarsest in {@link ImagePyramid.levels}.
 */
export interface ImagePyramidLevel {
  /** Format-specific source path for diagnostics and custom fetchers. */
  path      : string;
  /** Level dimensions in voxels [x,y,z]. Use z=1 for 2D data. */
  shape     : Vec3;
  /** Storage chunk dimensions [x,y,z]. One rendered tile equals one chunk. */
  chunkSize : Vec3;
  /** Physical units per voxel [x,y,z], in PhysicalSpace.spatial.unit. */
  scale     : Vec3;
}

/**
 * Format-neutral multiscale image metadata consumed by Galavi rendering.
 *
 * Adapters for OME-Zarr, OME-TIFF, and future formats normalize their native
 * metadata into this interface; format parsing does not belong in Galavi.
 */
export interface ImagePyramid {
  levels: ImagePyramidLevel[];
}

// TODO: Implement OME-TIFF normalization in a separate adapter package that returns ImagePyramid.

/** Resolution currently selected and displayed by one tiled layer in one view. */
export interface ViewResolution {
  /** Coarsest pyramid level currently supplying visible pixels. */
  level                 : number;
  /** Best-fit level currently requested by automatic selection. */
  targetLevel           : number;
  /** Physical units per source pixel/voxel at `level`. */
  sourceUnitsPerPixel   : number;
  /** Physical world units represented by one canvas pixel. */
  viewportUnitsPerPixel : number;
  /** Effective visible resolution: max(source, viewport), in physical units/px. */
  unitsPerPixel         : number;
}

/** Data configuration */
export interface Data {
  /** Source URL or path */
  url?: string;
  /** Normalized multiscale image metadata for tiled raster layers. */
  pyramid?: ImagePyramid;
  /**
   * URL template for tile/surface fetching.
   *
   * Placeholders: {url}, {level}, {x}, {y}, {z}.
   * Selection-dimension placeholders from `options.selection`
   * (e.g. {c} for channel).
   *
   * @example "{url}:img3d:{level}:{c}:{z},{y},{x}"
   */
  urlTemplate?: string;
  /** Custom fetch function (overrides urlTemplate) */
  fetch?: (options?: {
    level?: number;
    position?: number[];
    selection?: Record<string, number>;
  }) => Promise<ArrayBuffer>;

  transform?: number[]; // Optional 4×4 affine matrix, column-major
}

/** Render configuration */
export interface Render {
  /** Opacity (0–1) */
  opacity?        : number;
  /** Blending mode (default: 'translucent') */
  blending?       : 'translucent' | 'opaque' | 'additive' | 'minimum';
  /** Colormap name (e.g. 'gray', 'magma', 'viridis') */
  colormap?       : string;
  /** Single-color ramp override (e.g. '#FF0000') */
  color?          : string;
  /** Contrast limits [min, max] in normalized [0,1] range */
  contrastLimits? : [number, number];
  /** Whether this layer is visible */
  visible?        : boolean;
  /** Render geometry as wireframe (consumed by mesh-style layers). */
  wireframe?      : boolean;
  /** Disable back-face culling (consumed by mesh-style layers). */
  doubleSided?    : boolean;
  /** Shading model for surface-like layers. */
  shading?        : "surface" | "flat" | "wireframe" | "xray";
}

// ============================================================================
// EXPLORATION
// ============================================================================

/** Camera — position and orientation in physical space */
export interface Camera {
  /** Navigation mode */
  navMode   : "orbit" | "fly";
  /** Projection mode */
  projMode  : "perspective" | "orthographic";
  /** Camera position spatial coordinates */
  position  : Vec3;
  /** Focal point spatial coordinates */
  target    : Vec3;
  /** Up direction vector, default [0,1,0] */
  up?       : Vec3;
}

/** Temporal navigation state */
export interface Temporal {
  /** Current frame index */
  timepoint : number;
  /** Whether playback is active */
  playing   : boolean;
  /** Playback rate (frames per second) */
  fps       : number;
}

// ============================================================================
// STATE FLOW
// ============================================================================

/** Control action dispatched from view input or runtime updates. */
export interface Action {
  type      : string;
  payload?  : unknown;
}
