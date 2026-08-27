/**
 * Galavi - Scientific data visualization library based on WebGPU.
 *
 * This is the ONE main surface: the high-level Viewer facade, the state
 * schema (the portable scene document), the dataset boundary, the
 * composition axis, the low-level runtime, the primitives (views, layers,
 * controls, overlays) for plugin authors, and the shared utils. The OME-Zarr
 * loader lives in `galavi/ome-zarr`.
 */

// === Viewer facade ===
// The common scientific viewer: one dataset session, a composition, channels,
// camera, controls/tools, and status — translated onto the low-level scene
// model. `viewer.runtime` is the escape hatch.
export {
  Viewer,
  ViewerSupersededError,
  createViewer,
} from "./viewer";
export type {
  ViewerCamera,
  ViewerChannelAccessor,
  ViewerChannelConfig,
  ViewerChannelPatch,
  ViewerCompositionAccessor,
  ViewerCompositionOverride,
  ViewerConfig,
  ViewerControlAccessor,
  ViewerControlName,
  ViewerControlOptionsMap,
  ViewerControlsConfig,
  ViewerEventMap,
  ViewerEventName,
  ViewerMagnifierOptions,
  ViewerProjection,
  ViewerRoiActiveChangeEvent,
  ViewerRoiChangeEvent,
  ViewerRoiOptions,
  ViewerStatus,
  ViewerToolAccessor,
  ViewerToolName,
  ViewerToolOptionsMap,
  ViewerToolsConfig,
} from "./viewer";

// === State ===
// The portable document vocabulary lives in state/schema.ts; transport is
// plain JSON — validateState rejects function-backed values (`Data.fetch`,
// parsed `Data.geometry`) rather than silently dropping them. `State` is the
// ONE unified scene document: `viewer.getState()` emits it (facade sections),
// runtime consumers author `layers` directly.
export {
  normalizeState,
  validateState,
} from "./state";
export type {
  ChannelState,
  CompositionReference,
  JsonObject,
  JsonValue,
  State,
} from "./state";
// The raw scene model (runtime-level vocabulary) + common vector/physical
// types — all owned by state/schema.ts.
export type {
  ID,
  Vec2,
  Vec3,
  PhysicalUnit,
  PhysicalSpace,
  LayerConfig,
  Exploration,
  SpatialConfig,
  TemporalConfig,
  ChannelConfig,
  Data,
  ImagePyramid,
  ImagePyramidLevel,
  ViewResolution,
  Render,
  VolumeRenderMode,
  Camera,
  Temporal,
  Action,
} from "./state/schema";

// === Dataset ===
// One dataset/session abstraction: kinds register via registerDatasetAdapter
// (the single dataset/source extension point); openDataset constructs and
// loads a fresh Dataset per call. Format loaders (e.g. "ome-zarr") live in
// subpaths (galavi/ome-zarr) and augment DatasetConfigMap with their exact
// config.
// A Dataset exposes normalized metadata and typed runtime RESOURCES
// (DatasetResourceMap, augmentable like DatasetConfigMap); translating
// resources into scenes is the composition layer's job, not the Dataset's.
export {
  Dataset,
  mesh,
  openDataset,
} from "./dataset";
export type {
  DatasetConfig,
  DatasetConfigMap,
  DatasetChannel,
  DatasetDimension,
  DatasetResource,
  DatasetResourceMap,
  ImagePyramidFetch,
  ImagePyramidResource,
  MeshResource,
} from "./dataset";
export { registerDatasetAdapter } from "./registry";
export { CapabilityResolutionError } from "./registry";
export type { DatasetAdapter } from "./dataset";
// Dataset authoring: the built-in mesh loader is an authoring tool; the
// channel vocabulary (colors + contrast limits) is part of the dataset
// contract — plugin adapters use it to normalize format channel metadata.
export {
  MeshDataset,
} from "./dataset";
export {
  CHANNEL_FALLBACK_COLORS,
  CONTRAST_RANGE,
  normalizeHexColor,
  getChannelColor,
  clampContrastLimits,
  buildContrastLimits,
} from "./dataset";

// === Composition ===
// The composition contract (ViewerComposition/CompositionPlan/bindings), the
// composition registry extension point, and the built-in compositions.
// Built-ins and custom compositions traverse the same resolve/build/mount path.
export {
  registerComposition,
} from "./viewer/compositions";
export type {
  CompositionBindings,
  CompositionBuildInput,
  CompositionInput,
  CompositionPlan,
  HostLayout,
  ViewerComposition,
} from "./viewer/compositions";

// === Runtime (low-level orchestrator) ===
// `createViewerRuntime` / `ViewerRuntime` — the explicit multi-view scene
// orchestrator (state authority, shared runtime layers, GPU device).
export {
  ViewerRuntime,
  createViewerRuntime,
} from "./viewer";
export type {
  CreateViewerRuntimeOptions,
  LayerPatch,
  ViewerRuntimeConfig,
  ViewConfig,
  ControlOptions,
  OverlayOptions,
} from "./viewer";

// === Building Blocks Extension API (registries) ===
export {
  registerControl,
  registerOverlay,
  registerLayer,
  registerView,
} from "./registry";

// === Primitives ===
// Base + built-in layer/view/control/overlay classes for plugin authors, the
// typed per-layer/per-overlay option bags — including the callback-bearing
// overlay options (the high-level Viewer surface is JSON-only;
// runtime callbacks are a low-level feature) — and the Viewer config control
// option bags.
export { BaseControl } from "./primitives/control";
export type {
  OrbitControlOptions,
  FlyControlOptions,
  PanZoomControlOptions,
} from "./primitives/control";
export {
  BaseOverlay,
  CrosshairOverlay,
  RulerOverlay,
  RoiSelectorOverlay,
  MagnifierOverlay,
  type MagnifierDimension,
  type MagnifierOptions,
  FoldablePanelOverlay,
  type BaseOverlayOptions,
  type CrosshairOverlayOptions,
  type RulerOverlayOptions,
  type RoiSelectorOverlayOptions,
  type FoldablePanelOverlayOptions,
  type MagnifierOverlayOptions,
  type OverlayOptionsMap,
  type RoiSelectionsChangeCallback,
  type RoiActiveIndexChangeCallback,
  type OverlayCornerPosition,
  type OverlayLabelVariant,
} from "./primitives/overlay";
// ROI event payload building blocks — the shapes inside
// `ViewerRoiChangeEvent`.
export type {
  RoiBox,
  RoiChangeKind,
  RoiChangePhase,
  RoiSelectionChange,
} from "./primitives/overlay";
// Theme (app-facing helpers).
export {
  DEFAULT_THEME,
  FUI_THEME,
  PRECISION_THEME,
  resolveTheme,
  mergeTheme,
  applyThemeTo,
  type GalaviTheme,
  type DeepPartial,
} from "./primitives/overlay/theme";
export {
  BaseLayer,
  MIN_VEC4_BUFFER,
  type Geometry,
  type Shader,
  type LayerParams,
  type LayerClass,
  type LayerLoadStatus,
  type LayerLoadState,
} from "./primitives/layer";
export {
  TiledImageLayer,
  type TileLevelContext,
  type TileLevelGrid,
  type TiledImageOptions,
} from "./primitives/layer";
export type {
  VolumeOptions,
  VolumeLayerConfig,
  SliceOptions,
  SliceLayerConfig,
  SurfaceOptions,
  SurfaceLayerConfig,
  ShapesOptions,
  ShapesLayerConfig,
  PointsOptions,
  PointsLayerConfig,
  SegmentationOptions,
  SegmentationLayerConfig,
  VectorsOptions,
  VectorsLayerConfig,
  TracksOptions,
  TracksLayerConfig,
  NetworkOptions,
  NetworkLayerConfig,
} from "./primitives/layer";
export { BaseView } from "./primitives/view";

// === Utils (public extension API) ===
//
// Reusable building blocks for plugin authors writing controls, layers, views,
// or source adapters. Grouped by category:
//
//   - Camera math       — clampPitch, cameraDistance, cameraAngles,
//                         computePosition, computeForward,
//                         frameVolumeCamera, fitSliceCamera
//   - Axes              — resolveAxes, AxisIndex, AxisMap
//   - Geometry          — EMPTY_VERTEX_BUFFER, UNIT_CUBE, aabbFromPositions
//   - Colormaps         — getColormapLUT, COLORMAP_NAMES, ColormapName,
//                         APPEARANCE_PRESETS, resolveAppearancePreset,
//                         AppearancePresetId, parseHexColor
//   - Tile / pyramid    — TilePool, TileLoadQueue, TileManager, TileSource,
//                         TileLoader, TilePlacement, TilePlan, TileCoord,
//                         TilePoolConfig, planTiles, tileId, buildTileFetcher,
//                         sourceChanged, resolveDataUrl,
//                         countPyramidLevelTiles, pickPyramidLevel,
//                         TileBounds, TileViewport,
//                         planVolumePreview + VOLUME_PREVIEW_* budgets
//                         (automatic volume tile-budget policy),
//                         floatToFloat16, dtypeNormalization, makeFloat16Encoder
//   - Input             — normalizeWheel, normalizeDrag
//   - Vectors           — cameraBasis, subtract, cross, dot, normalize
//
export * from "./utils";

// === Tile streaming (viewer-side rendering substrate) ===
// TilePool/TileManager/planTiles/planVolumePreview … — tile streaming + GPU
// residency (src/viewer/tile/). Re-exported from the root directly: the
// utils barrel may not import viewer code, so it cannot re-export these.
export {
  TilePool,
  TileLoadQueue,
  TileManager,
  tileId,
  buildTileFetcher,
  sourceChanged,
  resolveDataUrl,
  pickPyramidLevel,
  countPyramidLevelTiles,
  planTiles,
  planVolumePreview,
  VOLUME_PREVIEW_MAX_SLABS,
  VOLUME_PREVIEW_MAX_TILES,
  VOLUME_PREVIEW_MAX_CHUNK_TEXELS,
  VOLUME_PREVIEW_POOL_HEADROOM,
  type VolumePreviewPlan,
  type TilePoolConfig,
  type TileCoord,
  type TileSource,
  type TileSpec,
  type TileFramePlan,
  type TilePlacement,
  type TilePlan,
  type TileLoader,
  type TileCommitResult,
  type TileBounds,
  type TileViewport,
  type PyramidLevelSelection,
} from "./viewer/tile";

// === Defaults (stable semantic constants) ===
export { DEFAULT_FOV } from "./defaults";
