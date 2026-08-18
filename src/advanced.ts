/**
 * Galavi ADVANCED entry (API-6) — the low-level authoring surface:
 *
 * - `createViewerEngine` / `ViewerEngine` — the explicit multi-view scene
 *   orchestrator (state authority, shared runtime layers, GPU device),
 * - the raw scene model (`State`, `ViewConfig`, `LayerConfig`, `LayerPatch`,
 *   camera/render/data types),
 * - the registries and the base + built-in layer/view/control/overlay
 *   classes for plugin authors,
 * - the typed per-layer/per-overlay option bags — including the
 *   callback-bearing overlay options (API-4: the high-level Viewer surface
 *   is JSON-only; runtime callbacks are a low-level feature),
 * - the camera/projection/tile/plugin utilities.
 *
 * The common root surface (`createViewer`, dataset opening, themes, Viewer
 * event payloads, …) is re-exported here so advanced consumers have one
 * import site. Import `galavi` instead when only the common facade is needed.
 */

export * from "./index";

// === Engine (low-level orchestrator) ===
export {
  ViewerEngine,
  createViewerEngine,
} from "./viewer";
export type {
  LayerPatch,
} from "./viewer";

// === Raw scene model ===
export type {
  ViewerEngineConfig,
  State,
  ViewConfig,
  ControlOptions,
  OverlayOptions,
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

// === Building Blocks Extension API (registries) ===
export {
  registerControl,
  registerOverlay,
  registerLayer,
  registerView,
} from "./registry";

// === Dataset authoring ===
// The Dataset base class and registerDataset live on the common root (and are
// re-exported above); the built-in mesh loader and the pyramid-capabilities
// helper are authoring tools for the advanced surface.
export {
  MeshDataset,
  getDatasetCapabilities,
} from "./dataset";

// === Controls ===
export { BaseControl } from "./control";

// === Overlays (base + built-ins, incl. callback-bearing option bags) ===
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
} from "./overlay";

// === Layers (base + built-ins, per-layer option bags + typed configs) ===
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

// === Views ===
export { BaseView } from "./view";

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
