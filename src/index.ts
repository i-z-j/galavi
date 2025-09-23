/**
 * Galavi - Scientific data visualization library based on WebGPU.
 */

// === Core API ===
export {
  Galavi,
  createGalavi,
} from "./main";

// === Types ===
export type {
  ID,
  Vec2,
  Vec3,
  PhysicalUnit,
  GalaviConfig,
  State,
  ViewConfig,
  PhysicalSpace,
  LayerConfig,
  Exploration,
  SpatialConfig,
  TemporalConfig,
  ChannelConfig,
  Data,
  Render,
  Camera,
  Lod,
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
} from "./registry";

export { BaseControl } from "./control";
export { BaseOverlay } from "./overlay";
export { BaseLayer } from "./layer";
export { BaseView } from "./view";

// === Utils (public extension API) ===
//
// Reusable building blocks for plugin authors writing controls, layers, views,
// or source adapters. Grouped by category:
//
//   - Camera math       — clampPitch, cameraDistance, cameraAngles,
//                         computePosition, computeForward
//   - Axes              — resolveAxes, AxisIndex, AxisMap
//   - Geometry          — EMPTY_VERTEX_BUFFER, UNIT_CUBE, aabbFromPositions
//   - Colormaps         — getColormapLUT, COLORMAP_NAMES, ColormapName,
//                         APPEARANCE_PRESETS, resolveAppearancePreset,
//                         AppearancePresetId, parseHexColor
//   - Tile / pyramid    — TilePool, TileLoadQueue, TileManager, TileSource,
//                         TileLoader, TilePlacement, TilePlan, TileCoord,
//                         TilePoolConfig, planTiles, tileId, buildTileFetcher,
//                         sourceChanged, resolveDataUrl,
//                         getPyramidLevelScale, clampPyramidLevel,
//                         pickPyramidLevel, resolvePyramidLevel,
//                         floatToFloat16
//   - Input             — normalizeWheel, normalizeDrag
//
export * from "./utils";
