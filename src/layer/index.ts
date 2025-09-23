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
	getBlendConfig,
	transformAABB,
	type BlendConfig,
	type Geometry,
	type Shader,
	type LayerParams,
	type LayerClass,
	type VertexAttribute,
} from "./base";

// Concrete layer classes — consumed by registry.ts and (where applicable)
// directly by views (e.g. NavigatorView holds an internal PlanesLayer).
// Layer-internal helper types stay private to each layer subfolder.
export { VolumeLayer,       type VolumeConfig       } from "./volume/main";
export { SliceLayer,        type SliceConfig        } from "./slice/main";
export { SurfaceLayer,      type SurfaceConfig      } from "./surface/main";
export { ShapesLayer,       type ShapesConfig       } from "./shape/main";
export { PointsLayer,       type PointsConfig       } from "./points/main";
export { SegmentationLayer, type SegmentationConfig } from "./segmentation/main";
export { VectorsLayer,      type VectorsConfig      } from "./vectors/main";
export { TracksLayer,       type TracksConfig       } from "./tracks/main";
export { NetworkLayer,      type NetworkConfig      } from "./network/main";
export { PlanesLayer,       type PlanesConfig       } from "./planes/main";
