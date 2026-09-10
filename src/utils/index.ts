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
} from "./math/spherical";

// Fit-to-data camera helpers
export {
  frameVolumeCamera,
  fitSliceCamera,
  type FrameVolumeCameraOptions,
  type FitSliceCameraOptions,
} from "./math/camera-fit";

// Shared axis helpers
export {
  resolveAxes,
  type AxisIndex,
  type AxisMap,
} from "./math/axes";

// Shared geometry constants
export {
  EMPTY_VERTEX_BUFFER,
  UNIT_CUBE,
  aabbFromPositions,
} from "./render/geometry";

// Data source helpers (reload guard + URL resolution for `Data` configs)
export {
  dataSourceChanged,
  resolveDataUrl,
} from "./data-source";

// Colormaps and appearance presets
export {
  getColormapLUT,
  COLORMAP_NAMES,
  APPEARANCE_PRESETS,
  resolveAppearancePreset,
  parseHexColor,
  type ColormapName,
  type AppearancePresetId,
} from "./render/colormaps";

// Tile streaming system moved to `viewer/tile/` (rendering-runtime
// substrate) — re-exported from the ROOT entry, not here: utils may not
// import viewer code. The pure encoding helpers stay on this barrel via
// `./render`.
export { floatToFloat16 } from "./render/float16";
export {
  dtypeNormalization,
  makeFloat16Encoder,
} from "./render/pack";

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
} from "./render/projection";

// Channel colors and contrast limits live in the dataset contract
// (src/dataset/contract.ts) — re-exported from the dataset barrel.
