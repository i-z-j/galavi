/**
 * Tile — GPU texture cache for tiled data
 *
 * Split into focused modules:
 *   - source.ts   — TileCoord/TileSource, buildTileFetcher, resolveDataUrl,
 *                   sourceChanged
 *   - level.ts    — pickPyramidLevel, countPyramidLevelTiles, TileBounds
 *   - queue.ts    — TileLoadQueue
 *   - pool.ts     — TilePool, TilePoolConfig, TileSpec, TileViewport, tileId
 *   - planner.ts  — planTiles, TilePlacement, TilePlan
 *   - manager.ts  — TileManager, TileLoader, TileFramePlan
 *   - volume-policy.ts — planVolumePreview (automatic volume tile budgets)
 *   - float16.ts  — floatToFloat16
 *   - pack.ts     — dtypeNormalization, makeFloat16Encoder
 */

export {
  buildTileFetcher,
  resolveDataUrl,
  sourceChanged,
  type TileCoord,
  type TileSource,
} from "./source";

export {
  countPyramidLevelTiles,
  pickPyramidLevel,
  type PyramidLevelSelection,
  type TileBounds,
} from "./level";

export { TileLoadQueue } from "./queue";

export {
  TilePool,
  tileId,
  type TilePoolConfig,
  type TileSpec,
  type TileViewport,
} from "./pool";

export {
  planTiles,
  type TilePlacement,
  type TilePlan,
} from "./planner";

export {
  TileManager,
  type TileCommitResult,
  type TileFramePlan,
  type TileLoader,
} from "./manager";

export { floatToFloat16 } from "./float16";

export {
  planVolumePreview,
  VOLUME_PREVIEW_MAX_SLABS,
  VOLUME_PREVIEW_MAX_TILES,
  VOLUME_PREVIEW_MAX_CHUNK_TEXELS,
  VOLUME_PREVIEW_POOL_HEADROOM,
  type VolumePreviewPlan,
} from "./volume-policy";

export {
  dtypeNormalization,
  makeFloat16Encoder,
} from "./pack";
