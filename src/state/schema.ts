/**
 * State schema — ALL scene vocabulary plus the structural validation of the
 * portable document.
 *
 * This module is FOUNDATIONAL: it imports nothing from the rest of `src/`,
 * so every other module (defaults, dataset, utils, primitives, viewer) may
 * depend on it without creating a cycle.
 *
 * Content rule: a {@link State} contains everything necessary to reproduce
 * the scene, except resources that are resolved externally. References to
 * external resources are portable and belong in `State`; implementations and
 * data behind them stay out. A State is JSON-portable ONLY when every
 * `LayerConfig.data` is declarative: a `Data.fetch` function or pre-parsed
 * `Data.geometry` makes a layer runtime-bound, and {@link validateState}
 * rejects such documents for portable use — function-backed values are
 * rejected, never silently dropped. Transport is plain JSON
 * (`JSON.stringify` / `JSON.parse`); encoding concerns (compression, URLs,
 * history, storage) belong to the application.
 */

// ============================================================================
// PRIMITIVES
// ============================================================================

export type ID   = string;
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type PhysicalUnit = 'nm' | 'µm' | 'mm' | 'cm' | 'm';

// ============================================================================
// PORTABLE REFERENCE VOCABULARY
// ============================================================================

/** A JSON-serializable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON-serializable object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A declarative reference to a registered composition: the composition `type`
 * (registry key — never `"auto"`, which is creation-time selection intent)
 * plus an optional portable, composition-owned config bag.
 */
export interface CompositionReference {
  /** Composition type (registry key). */
  type     : string;
  /** Composition-owned portable settings (normalized by the composition). */
  config?  : JsonObject;
}

// ============================================================================
// DATASET DESCRIPTOR VOCABULARY
// ============================================================================

/**
 * Loader identity map: each dataset kind owns its exact declarative config
 * here, keyed by its `type` discriminator. Format packages augment this map
 * via module augmentation (see `galavi/ome-zarr`):
 *
 * ```ts
 * declare module "galavi" {
 *   interface DatasetConfigMap {
 *     "ome-zarr": { type: "ome-zarr"; source: string };
 *   }
 * }
 * ```
 *
 * Augmenting the map extends {@link DatasetConfig} and types
 * `registerDatasetAdapter` for the new kind — an unknown `type` key or a missing
 * required field is a compile error, not a runtime surprise.
 */
export interface DatasetConfigMap {
  /** Built-in OBJ mesh loader (always registered through the core entry). */
  mesh: { type: "mesh"; source: string };
}

/**
 * Declarative dataset configuration — the union of every registered loader's
 * config. `type` is the public loader identity resolving through
 * `datasetRegistry` (`registerDatasetAdapter`). Must survive
 * `JSON.parse(JSON.stringify(...))` unchanged — runtime resources never
 * appear here.
 */
export type DatasetConfig = DatasetConfigMap[keyof DatasetConfigMap];

// ============================================================================
// SURFACE GEOMETRY
// ============================================================================

/** Parsed surface geometry from OBJ or similar format */
export interface SurfaceGeometry {
  positions   : Float32Array;
  normals?    : Float32Array;
  uvs?        : Float32Array;
  indices?    : Uint16Array | Uint32Array;
  vertexCount : number;
  indexCount? : number;
}

/** Axis-aligned bounding box */
export interface AABB {
  min : Vec3;
  max : Vec3;
}

// ============================================================================
// STATE
// ============================================================================

/**
 * State — the global runtime scene state.
 *
 * Three tiers by update frequency:
 * - physical: physical coordinate system, set once, rarely changes (optional)
 * - layers: data layer configurations, moderate updates
 * - exploration: navigation and interaction state, frequent updates
 *
 * This is the ViewerRuntime's live scene document. It is JSON-portable ONLY
 * when every `LayerConfig.data` is declarative: a `Data.fetch` function or
 * pre-parsed `Data.geometry` makes a layer runtime-bound, and
 * {@link validateState} rejects such documents for portable use rather than
 * silently dropping the runtime values.
 *
 * Two population styles, one schema: facade viewers populate
 * `composition`/`channels`/`projection`/`tools`; runtime-level consumers
 * author `layers` directly. Mixing is allowed (dataset channels + explicit
 * annotation layers). All sections beyond `exploration`/`layers` are
 * optional, so existing runtime-path documents stay valid.
 */
export interface State {
  /** Declarative dataset descriptor (facade path) — never the runtime instance. */
  dataset?      : DatasetConfig;
  /** Resolved composition reference — never `"auto"`. */
  composition?  : CompositionReference;
  /** Physical coordinate system (optional — defaults to normalized [0,1]³ unitless space) */
  physical?     : PhysicalSpace;
  /**
   * Ordered layer list (first = bottom, last = top). OPTIONAL on the document:
   * facade viewers omit it (their layers are re-derived by the composition on
   * restore); runtime-level consumers author it directly. Runtime internals
   * assert its presence where needed.
   */
  layers?       : LayerConfig[];
  /** Navigation and interaction state */
  exploration   : Exploration;
  /** Dataset-driven channel intent (facade path). */
  channels?     : ChannelState[];
  /** Volume accumulation projection. */
  projection?   : VolumeRenderMode;
  /**
   * Tool state, keyed by tool name — tool VALUES (ROI selections, active ROI)
   * plus the declarative tool settings the facade mirrors. Values are any pure
   * JSON; functions are rejected by the JSON guard.
   */
  tools?        : Record<string, JsonValue>;
  /** Per-composition portable settings, keyed by composition type. */
  compositions? : Record<string, JsonObject>;
}

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

/**
 * One dataset-driven channel state (facade path): render-ready color
 * (`#RRGGBB`), contrast window in normalized [0, 1], and visibility.
 */
export interface ChannelState {
  /** Channel index — the `c` selection value of the underlying layers. */
  index    : number;
  /** Display label. */
  label    : string;
  /** Visibility. */
  visible  : boolean;
  /** Display color, `#RRGGBB`. */
  color    : string;
  /** Contrast window, normalized [0, 1] with low ≤ high. */
  contrast : [number, number];
}

// ============================================================================
// PHYSICAL SPACE
// ============================================================================

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
 *
 * 2D (XY-only) datasets are first-class: the adapter represents the missing
 * z axis as a singleton (`shape[2]` = `chunkSize[2]` = 1, with `scale[2]`
 * conventionally matching the y scale). All fields stay 3-component
 * regardless of source dimensionality, so tile pooling, planning, slicing,
 * and navigation need no 2D special cases.
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
 * Dataset kinds normalize their native metadata into this interface — the
 * in-package OME-Zarr kind is the reference implementation; format parsing
 * does not belong in Galavi.
 *
 * The pyramid is always XYZ: a 2D (XY-only) source is represented with a
 * singleton z (see {@link ImagePyramidLevel}), never with 2-component fields.
 */
export interface ImagePyramid {
  levels: ImagePyramidLevel[];
}

// OME-TIFF is not supported. Normalizing it into ImagePyramid is future work
// and would live in a separate adapter package outside this repository.

/** Resolution currently selected and displayed by one tiled layer in one view. */
export interface ViewResolution {
  /** Coarsest pyramid level currently supplying visible pixels. */
  level                 : number;
  /** Best-fit level currently requested by automatic selection. */
  targetLevel           : number;
  /** True until every tile in the target-level plan is resident. */
  refining              : boolean;
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
  /** Custom fetch function (overrides urlTemplate); honor `signal` when possible. */
  fetch?: (options?: {
    level?: number;
    position?: number[];
    selection?: Record<string, number>;
    signal?: AbortSignal;
  }) => Promise<ArrayBuffer>;

  /**
   * Pre-parsed surface geometry, handed in by a dataset that already fetched
   * and parsed the source during `load()` (e.g. `MeshDataset`). Consumed by
   * surface-style layers: when present, the layer adopts the geometry
   * directly — no network request, no second parse. `url` still
   * identifies the source for change detection and diagnostics.
   */
  geometry?: SurfaceGeometry;

  transform?: number[]; // Optional 4×4 affine matrix, column-major
}

/** Ray-march accumulation mode for volume rendering. */
export type VolumeRenderMode = "mip" | "minip" | "mean";

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
  /**
   * Volume ray-march accumulation projection (consumed by volume layers):
   * `"mip"` max-intensity, `"minip"` min-intensity, `"mean"` average of
   * samples. The same contrast window and colormap apply to the accumulated
   * value in every projection. Default: `"mip"`.
   */
  volumeProjection? : VolumeRenderMode;
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

// ============================================================================
// STRUCTURAL VALIDATION
// ============================================================================

const STATE_KEYS: readonly string[] = [
  "dataset", "composition", "physical", "layers", "exploration",
  "channels", "projection", "tools", "compositions",
];
const CAMERA_KEYS: readonly string[] = ["navMode", "projMode", "position", "target", "up"];
const EXPLORATION_KEYS: readonly string[] = ["camera", "temporal"];
const LAYER_KEYS: readonly string[] = ["id", "type", "data", "render", "options"];
const CHANNEL_STATE_KEYS: readonly string[] = ["index", "label", "visible", "color", "contrast"];
const SPATIAL_KEYS: readonly string[] = ["size", "unit", "spacing", "origin", "transform"];
const PHYSICAL_SPACE_KEYS: readonly string[] = ["spatial", "temporal", "channels"];
const VOLUME_RENDER_MODES: readonly VolumeRenderMode[] = ["mip", "minip", "mean"];

/** Plain JSON objects only — class instances and typed arrays are runtime-bound. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertKnownKeys(
  value : Record<string, unknown>,
  known : readonly string[],
  context : string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new Error(`${context}: unknown key "${key}" (expected: ${known.join(", ")})`);
    }
  }
}

function assertFiniteVec3(value: unknown, context: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new Error(`${context} must be a [x, y, z] finite number triple, got ${JSON.stringify(value)}`);
  }
  return [...value] as Vec3;
}

/**
 * Deep JSON clone with a hard runtime-value guard: a portable State is pure
 * JSON, so a function (e.g. `Data.fetch`), a typed array or class instance
 * (e.g. a parsed `Data.geometry`), or a non-finite number anywhere in the
 * document is rejected with an actionable path — never silently dropped by
 * serialization.
 */
function cloneJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number, got ${value} — State is pure JSON`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, i) => cloneJsonValue(entry, `${path}[${i}]`));
  }
  if (typeof value === "function") {
    throw new Error(
      `${path} is a function — State is pure JSON: function-backed values ` +
      "(such as Data.fetch) are rejected, never silently dropped",
    );
  }
  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new Error(
        `${path} is not a plain JSON object — State is pure JSON: runtime values ` +
        "(such as a parsed Data.geometry's typed arrays) are rejected, never silently dropped",
      );
    }
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue; // JSON drops undefined-valued keys
      out[key] = cloneJsonValue(entry, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`${path} is not JSON-serializable (${typeof value}) — State is pure JSON`);
}

function validateCamera(value: unknown, context: string): Camera {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a camera object, got ${JSON.stringify(value)}`);
  }
  assertKnownKeys(value, CAMERA_KEYS, context);
  if (value.navMode !== "orbit" && value.navMode !== "fly") {
    throw new Error(`${context}.navMode must be "orbit" or "fly", got ${JSON.stringify(value.navMode)}`);
  }
  if (value.projMode !== "perspective" && value.projMode !== "orthographic") {
    throw new Error(`${context}.projMode must be "perspective" or "orthographic", got ${JSON.stringify(value.projMode)}`);
  }
  return {
    navMode  : value.navMode,
    projMode : value.projMode,
    position : assertFiniteVec3(value.position, `${context}.position`),
    target   : assertFiniteVec3(value.target, `${context}.target`),
    ...(value.up !== undefined ? { up: assertFiniteVec3(value.up, `${context}.up`) } : {}),
  };
}

function validateExploration(value: unknown, context: string): Exploration {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an exploration object, got ${JSON.stringify(value)}`);
  }
  assertKnownKeys(value, EXPLORATION_KEYS, context);
  const exploration: Exploration = { camera: validateCamera(value.camera, `${context}.camera`) };
  if (value.temporal !== undefined) {
    const temporal = value.temporal;
    if (!isPlainObject(temporal)) {
      throw new Error(`${context}.temporal must be an object, got ${JSON.stringify(temporal)}`);
    }
    if (!Number.isFinite(temporal.timepoint) || typeof temporal.playing !== "boolean" || !Number.isFinite(temporal.fps)) {
      throw new Error(
        `${context}.temporal must carry a finite timepoint, a boolean playing flag, and a finite fps, ` +
        `got ${JSON.stringify(temporal)}`,
      );
    }
    exploration.temporal = temporal as unknown as Temporal;
  }
  return exploration;
}

function validatePhysicalSpace(value: unknown, context: string): PhysicalSpace {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a physical space object, got ${JSON.stringify(value)}`);
  }
  assertKnownKeys(value, PHYSICAL_SPACE_KEYS, context);
  const spatial = value.spatial;
  if (!isPlainObject(spatial)) {
    throw new Error(`${context}.spatial must be an object, got ${JSON.stringify(spatial)}`);
  }
  assertKnownKeys(spatial, SPATIAL_KEYS, `${context}.spatial`);
  assertFiniteVec3(spatial.size, `${context}.spatial.size`);
  if (spatial.unit !== undefined && typeof spatial.unit !== "string") {
    throw new Error(`${context}.spatial.unit must be a string, got ${JSON.stringify(spatial.unit)}`);
  }
  if (spatial.spacing !== undefined) assertFiniteVec3(spatial.spacing, `${context}.spatial.spacing`);
  if (spatial.origin !== undefined) assertFiniteVec3(spatial.origin, `${context}.spatial.origin`);
  if (spatial.transform !== undefined) {
    const t = spatial.transform;
    if (!Array.isArray(t) || t.length !== 16 || !t.every(Number.isFinite)) {
      throw new Error(
        `${context}.spatial.transform must be an array of 16 finite numbers (4×4 column-major affine), ` +
        `got ${JSON.stringify(t)}`,
      );
    }
  }
  return value as unknown as PhysicalSpace;
}

function validateLayers(value: unknown, context: string): LayerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array of layer configs, got ${JSON.stringify(value)}`);
  }
  return value.map((layer, i) => {
    const path = `${context}[${i}]`;
    if (!isPlainObject(layer)) {
      throw new Error(`${path} must be a layer config object, got ${JSON.stringify(layer)}`);
    }
    assertKnownKeys(layer, LAYER_KEYS, path);
    if (typeof layer.id !== "string" || layer.id.length === 0) {
      throw new Error(`${path}.id must be a non-empty string, got ${JSON.stringify(layer.id)}`);
    }
    if (typeof layer.type !== "string" || layer.type.length === 0) {
      throw new Error(`${path}.type must be a non-empty string, got ${JSON.stringify(layer.type)}`);
    }
    for (const key of ["data", "render", "options"] as const) {
      const section = layer[key];
      if (section !== undefined && !isPlainObject(section)) {
        throw new Error(`${path}.${key} must be a plain object, got ${JSON.stringify(section)}`);
      }
    }
    const render = layer.render;
    if (render !== undefined) {
      const opacity = (render as Record<string, unknown>).opacity;
      if (opacity !== undefined && (typeof opacity !== "number" || opacity < 0 || opacity > 1)) {
        throw new Error(`${path}.render.opacity must be a number in [0, 1], got ${JSON.stringify(opacity)}`);
      }
    }
    return layer as unknown as LayerConfig;
  });
}

function validateChannelState(value: unknown, context: string): ChannelState {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a channel state object, got ${JSON.stringify(value)}`);
  }
  assertKnownKeys(value, CHANNEL_STATE_KEYS, context);
  if (!Number.isInteger(value.index) || (value.index as number) < 0) {
    throw new Error(`${context}: index must be a non-negative integer, got ${JSON.stringify(value.index)}`);
  }
  if (typeof value.label !== "string") {
    throw new Error(`${context}: label must be a string, got ${JSON.stringify(value.label)}`);
  }
  if (typeof value.visible !== "boolean") {
    throw new Error(`${context}: visible must be a boolean, got ${JSON.stringify(value.visible)}`);
  }
  if (typeof value.color !== "string") {
    throw new Error(`${context}: color must be a string (#RRGGBB), got ${JSON.stringify(value.color)}`);
  }
  const contrast = value.contrast;
  if (
    !Array.isArray(contrast) || contrast.length !== 2 ||
    !contrast.every(Number.isFinite) ||
    contrast[0] < 0 || contrast[1] > 1 || contrast[0] > contrast[1]
  ) {
    throw new Error(
      `${context}: contrast must be a [min, max] pair in [0, 1] with min ≤ max, got ${JSON.stringify(contrast)}`,
    );
  }
  return value as unknown as ChannelState;
}

function validateCompositionReference(value: unknown, context: string): CompositionReference {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a composition reference object, got ${JSON.stringify(value)}`);
  }
  assertKnownKeys(value, ["type", "config"], context);
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error(`${context}.type must be a non-empty composition type string, got ${JSON.stringify(value.type)}`);
  }
  if (value.type === "auto") {
    throw new Error(
      `${context}.type must be a resolved composition type — "auto" is creation-time ` +
      "selection intent, never a stored reference",
    );
  }
  if (value.config !== undefined && !isPlainObject(value.config)) {
    throw new Error(`${context}.config must be a plain object, got ${JSON.stringify(value.config)}`);
  }
  return value as unknown as CompositionReference;
}

/**
 * Light structural validation of a declarative dataset descriptor: a plain
 * object with a non-empty `type` string. Kind-level validation (required
 * fields per kind) belongs to the adapter at open time; the JSON guard
 * rejects any runtime values inside.
 */
function validateDatasetConfig(value: unknown, context: string): DatasetConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a dataset config object, got ${JSON.stringify(value)}`);
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error(`${context}.type must be a non-empty dataset kind string, got ${JSON.stringify(value.type)}`);
  }
  return value as unknown as DatasetConfig;
}

/** `Record<string, JsonObject>` section (compositions). */
function validateJsonObjectRecord(value: unknown, context: string): Record<string, JsonObject> {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object keyed by name, got ${JSON.stringify(value)}`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      throw new Error(`${context}.${key} must be a plain object, got ${JSON.stringify(entry)}`);
    }
  }
  return value as unknown as Record<string, JsonObject>;
}

/**
 * Validate one JSON-safe object (a composition config, a tool value bag, …):
 * a plain object, deep-cloned through the JSON guard so function-backed values
 * and non-finite numbers are rejected with an actionable path — never silently
 * dropped.
 */
export function validateJsonObject(value: unknown, context: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain JSON object, got ${JSON.stringify(value)}`);
  }
  return cloneJsonValue(value, context) as JsonObject;
}

/**
 * Validate and canonicalize a portable {@link State} document: known keys
 * only, every section shape-checked (camera vectors, channel ranges,
 * reference shapes), and the result deep-cloned through the JSON guard so
 * function-backed values (`Data.fetch`), typed arrays (`Data.geometry`), and
 * non-finite numbers are rejected with an actionable path — never silently
 * dropped.
 *
 * `layers` is OPTIONAL on the document: facade viewers omit it (their layers
 * are re-derived by the composition on restore); runtime-level consumers author
 * it directly. `exploration` is always required.
 *
 * This validation is STRUCTURAL only: capability references (dataset kinds,
 * composition types, layer types) are open strings resolved against
 * registries later, at open/restore time. Transport is plain JSON —
 * `validateState(JSON.parse(JSON.stringify(state)))` round-trips.
 */
export function validateState(input: unknown, context = "state"): State {
  if (!isPlainObject(input)) {
    throw new Error(`${context} must be a State object, got ${JSON.stringify(input)}`);
  }
  assertKnownKeys(input, STATE_KEYS, context);
  const exploration = validateExploration(input.exploration, `${context}.exploration`);
  // Key order is stable (layers first, matching the historical document
  // shape) — JSON.stringify comparisons of canonical documents rely on it.
  const state: State = {
    ...(input.layers !== undefined
      ? { layers: validateLayers(input.layers, `${context}.layers`) }
      : {}),
    exploration,
  };
  if (input.dataset !== undefined) {
    state.dataset = validateDatasetConfig(input.dataset, `${context}.dataset`);
  }
  if (input.physical !== undefined) {
    state.physical = validatePhysicalSpace(input.physical, `${context}.physical`);
  }
  if (input.composition !== undefined) {
    state.composition = validateCompositionReference(input.composition, `${context}.composition`);
  }
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels)) {
      throw new Error(`${context}.channels must be an array of channel states, got ${JSON.stringify(input.channels)}`);
    }
    state.channels = input.channels.map((entry, i) => validateChannelState(entry, `${context}.channels[${i}]`));
  }
  if (input.projection !== undefined) {
    if (!VOLUME_RENDER_MODES.includes(input.projection as VolumeRenderMode)) {
      throw new Error(
        `${context}.projection must be one of: ${VOLUME_RENDER_MODES.join(", ")}, ` +
        `got ${JSON.stringify(input.projection)}`,
      );
    }
    state.projection = input.projection as VolumeRenderMode;
  }
  if (input.tools !== undefined) {
    state.tools = validateJsonObjectRecord(input.tools, `${context}.tools`);
  }
  if (input.compositions !== undefined) {
    state.compositions = validateJsonObjectRecord(input.compositions, `${context}.compositions`);
  }
  // Canonical deep clone: pure JSON out, runtime values rejected.
  return cloneJsonValue(state, context) as unknown as State;
}
