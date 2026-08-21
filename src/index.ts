/**
 * Galavi - Scientific data visualization library based on WebGPU.
 *
 * This is the COMMON entry (API-6): the high-level Viewer facade, dataset
 * opening/registration, common vector/physical types, the app-facing theme
 * helpers, and the Viewer event payload types. The low-level authoring
 * surface — `ViewerEngine`, registries, base + built-in layer/view/control/
 * overlay classes, typed layer options (incl. callback-bearing overlay
 * options), camera/projection/tile/plugin utilities — lives in
 * `galavi/advanced`; the OME-Zarr loader in `galavi/ome-zarr`.
 */

// === High-level Viewer facade (DX-L1/L2/M3/M6) ===
// The common scientific viewer: one dataset session, modes, channels, camera,
// controls/tools, and status — translated onto the low-level scene model
// (engineering-cleanup-plan.md §15). `viewer.engine` is the escape hatch.
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
  ViewerEventMap,
  ViewerEventName,
  ViewerMagnifierOptions,
  ViewerMode,
  ViewerModeOverride,
  ViewerModeOverrides,
  ViewerProjection,
  ViewerRoiActiveChangeEvent,
  ViewerRoiChangeEvent,
  ViewerRoiOptions,
  ViewerStatus,
  ViewerToolAccessor,
  ViewerToolName,
  ViewerToolOptionsMap,
  ViewerToolsConfig,
  ViewerViewAccessor,
} from "./viewer";

// === Dataset opening + registration ===
// One dataset/session abstraction: kinds register via registerDataset (the
// single dataset/source extension point); openDataset constructs and loads a
// fresh Dataset per call. Format loaders (e.g. "ome-zarr") live in subpaths
// (galavi/ome-zarr) and augment DatasetConfigMap with their exact config.
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
  DatasetCapabilities,
  DefaultLayersOptions,
} from "./dataset";
export { registerDataset } from "./registry";
export type { DatasetFactory } from "./registry";

// === Common vector/physical types ===
export type {
  ID,
  Vec2,
  Vec3,
  PhysicalUnit,
  PhysicalSpace,
} from "./types";

// === Viewer config control option bags ===
export type {
  OrbitControlOptions,
  FlyControlOptions,
  PanZoomControlOptions,
} from "./control";

// === ROI event payload building blocks ===
// The shapes inside `ViewerRoiChangeEvent`; the callback-bearing overlay
// options stay in `galavi/advanced` (API-4).
export type {
  RoiBox,
  RoiChangeKind,
  RoiChangePhase,
  RoiSelectionChange,
} from "./overlay";

// === Theme (app-facing helpers) ===
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
