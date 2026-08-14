/**
 * Galavi - Scientific data visualization library based on WebGPU.
 */

// === Core API ===
// Low-level composition: the engine + its config (advanced path; the Viewer
// facade below covers the common scientific viewer).
export {
  ViewerEngine,
  createViewerEngine,
} from "./viewer";

// === Types ===
export type {
  ID,
  Vec2,
  Vec3,
  PhysicalUnit,
  ViewerEngineConfig,
  State,
  ViewConfig,
  ControlOptions,
  OverlayOptions,
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
} from "./types";

export type {
  OrbitControlOptions,
  FlyControlOptions,
  PanZoomControlOptions,
} from "./control";

// === Building Blocks Extension API ===
export {
  registerControl,
  registerOverlay,
  registerLayer,
  registerView,
  registerDataset,
} from "./registry";
export type {
  DatasetFactory,
} from "./registry";

// === High-level Viewer facade (DX-L1/L2/M3/M6) ===
// The common scientific viewer: one dataset session, modes, channels, camera,
// controls/tools, and status — translated onto the low-level scene model
// (engineering-cleanup-plan.md §15). `createViewerEngine` remains the advanced
// path; `viewer.engine` is the escape hatch.
export {
  Viewer,
  ViewerSupersededError,
  createViewer,
} from "./viewer";
export type {
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
} from "./viewer";

// === Dataset building block ===
// One dataset/session abstraction: kinds register via registerDataset (the
// single dataset/source extension point); openDataset constructs and loads a
// fresh Dataset per call. Image kinds (e.g. "image" / OME-Zarr) live outside
// the core package.
export {
  Dataset,
  MeshDataset,
  openDataset,
  getDatasetCapabilities,
} from "./dataset";
export type {
  DatasetConfig,
  DatasetChannel,
  DatasetDimension,
  DatasetCapabilities,
  DatasetDefaults,
  DefaultLayersOptions,
} from "./dataset";

export { BaseControl } from "./control";
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
  type RoiBox,
  type RoiChangeKind,
  type RoiChangePhase,
  type RoiSelectionChange,
  type RoiSelectionsChangeCallback,
  type RoiActiveIndexChangeCallback,
  type OverlayCornerPosition,
  type OverlayLabelVariant,
} from "./overlay";
export {
  BaseLayer,
  MIN_VEC4_BUFFER,
  type Geometry,
  type Shader,
  type LayerParams,
  type LayerClass,
  type LayerLoadStatus,
  type LayerLoadState,
} from "./layer";
export {
  TiledImageLayer,
  type TileLevelContext,
  type TileLevelGrid,
  type TiledImageOptions,
} from "./layer";

// === Per-layer option bags + typed LayerConfig aliases ===
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
} from "./layer";
export { BaseView } from "./view";

// === Theme ===
export {
  DEFAULT_THEME,
  FUI_THEME,
  PRECISION_THEME,
  resolveTheme,
  mergeTheme,
  applyThemeTo,
  type GalaviTheme,
  type DeepPartial,
} from "./overlay/theme";

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
//                         (automatic volume tile-budget policy, DX-M4),
//                         floatToFloat16, dtypeNormalization, makeFloat16Encoder
//   - Input             — normalizeWheel, normalizeDrag
//   - Vectors           — cameraBasis, subtract, cross, dot, normalize
//
export * from "./utils";

// === Defaults (stable semantic constants) ===
export { DEFAULT_FOV } from "./defaults";
