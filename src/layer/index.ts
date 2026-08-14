/**
 * Layer Module — registry-centric internal barrel.
 *
 * Re-exports `BaseLayer` and the concrete layer classes used by `registry.ts`.
 * Utility re-exports (TilePool, colormaps, AxisMap, …) belong on `../utils`,
 * not here. Each concrete layer is imported directly from its
 * sub-folder `main.ts` — there are no per-folder `index.ts` barrels.
 */

// Base
export {
	BaseLayer,
	MIN_VEC4_BUFFER,
	getBlendConfig,
	transformAABB,
	type BlendConfig,
	type Geometry,
	type Shader,
	type LayerParams,
	type LayerClass,
	type LayerLoadStatus,
	type LayerLoadState,
	type VertexAttribute,
} from "./base";

// Shared tiled-image base (volume/slice)
export {
	TiledImageLayer,
	type TileLevelContext,
	type TileLevelGrid,
	type TiledImageOptions,
} from "./tiled-image";

// Concrete layer classes — consumed by registry.ts and views.
// Layer-internal helper types stay private to each layer subfolder.
export { VolumeLayer,       type VolumeConfig       } from "./volume/main";
export { optVolumeMode, VolumeLayerParams           } from "./volume/main";
export { SliceLayer,        type SliceConfig        } from "./slice/main";
export { SurfaceLayer,      type SurfaceConfig      } from "./surface/main";
export { ShapesLayer,       type ShapesConfig       } from "./shape/main";
export { PointsLayer,       type PointsConfig       } from "./points/main";
export { SegmentationLayer, type SegmentationConfig } from "./segmentation/main";
export { VectorsLayer,      type VectorsConfig      } from "./vectors/main";
export { TracksLayer,       type TracksConfig       } from "./tracks/main";
export { NetworkLayer,      type NetworkConfig      } from "./network/main";

// Per-layer option bags + typed LayerConfig aliases (config boundary).
export { type VolumeOptions,       type VolumeLayerConfig       } from "./volume/main";
export { type SliceOptions,        type SliceLayerConfig        } from "./slice/main";
export { type SurfaceOptions,      type SurfaceLayerConfig      } from "./surface/main";
export { type ShapesOptions,       type ShapesLayerConfig       } from "./shape/main";
export { type PointsOptions,       type PointsLayerConfig       } from "./points/main";
export { type SegmentationOptions, type SegmentationLayerConfig } from "./segmentation/main";
export { type VectorsOptions,      type VectorsLayerConfig      } from "./vectors/main";
export { type TracksOptions,       type TracksLayerConfig       } from "./tracks/main";
export { type NetworkOptions,      type NetworkLayerConfig      } from "./network/main";
