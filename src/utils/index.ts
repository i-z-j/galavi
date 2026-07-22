/**
 * Utils Module — reusable utilities
 */

// Spherical camera math
export {
  clampPitch,
  cameraDistance,
  cameraAngles,
  computePosition,
  computeForward,
} from "./spherical";

// Shared axis helpers
export {
  resolveAxes,
  type AxisIndex,
  type AxisMap,
} from "./axes";

// Shared geometry constants
export {
  EMPTY_VERTEX_BUFFER,
  UNIT_CUBE,
  aabbFromPositions,
} from "./geometry";

// Colormaps and appearance presets
export {
  getColormapLUT,
  COLORMAP_NAMES,
  APPEARANCE_PRESETS,
  resolveAppearancePreset,
  parseHexColor,
  type ColormapName,
  type AppearancePresetId,
} from "./colormaps";

// Tile streaming system
export {
  TilePool,
  TileLoadQueue,
  TileManager,
  tileId,
  buildTileFetcher,
  floatToFloat16,
  sourceChanged,
  resolveDataUrl,
  pickPyramidLevel,
  countPyramidLevelTiles,
  planTiles,
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
} from "./tile";

// Input normalization
export {
  normalizeWheel,
  normalizeDrag,
} from "./input";

// Projection (physical ↔ screen)
export {
  physicalToSliceScreen,
  screenToSlicePhysical,
  physicalToVolumeScreen,
  screenToVolumeTargetPlane,
  sliceUnitsPerPixel,
  volumeUnitsPerPixel,
} from "./projection";

// Anatomical orientation (biomedical axis metadata)
export {
  parseAnatomicalOrientation,
  buildSliceOrientations,
  canonicalToStorageIndex,
  type StorageAxis,
  type StorageAxisName,
  type AnatomicalAxis,
  type AnatomicalDirection,
  type OrientationSign,
  type SlicePlane,
  type OrientedSlicePlane,
  type OrientedAxis,
  type AnatomicalOrientation,
} from "./anatomical-orientation";

// Channel colors and contrast limits (biomedical)
export {
  CHANNEL_FALLBACK_COLORS,
  CONTRAST_RANGE,
  normalizeHexColor,
  getChannelColor,
  clampContrastLimits,
  buildContrastLimits,
} from "./channels";
