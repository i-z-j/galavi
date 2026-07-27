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

// Fit-to-data camera helpers
export {
  frameVolumeCamera,
  fitSliceCamera,
  type FrameVolumeCameraOptions,
  type FitSliceCameraOptions,
} from "./camera-fit";

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

// Config option parsing (checked readers for untyped option bags)
export {
  optArray,
  optAxis,
  optBoolean,
  optNumber,
  optNumberRecord,
  optString,
  optVec2,
  optVec3,
} from "./options";

// Projection (physical ↔ screen) + shared Vec3 math
export {
  physicalToSliceScreen,
  screenToSlicePhysical,
  physicalToVolumeScreen,
  screenToVolumeTargetPlane,
  sliceUnitsPerPixel,
  volumeUnitsPerPixel,
  cameraBasis,
  subtract,
  cross,
  dot,
  normalize,
} from "./projection";

// Channel colors and contrast limits
export {
  CHANNEL_FALLBACK_COLORS,
  CONTRAST_RANGE,
  normalizeHexColor,
  getChannelColor,
  clampContrastLimits,
  buildContrastLimits,
} from "./channels";
