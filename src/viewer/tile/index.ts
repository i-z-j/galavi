/**
 * Tile — tile streaming + GPU residency (viewer-side leaf module; imports
 * only `state/schema.ts` from src/).
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
 *
 * The pure encoding helpers (float16, pack) live in `utils/render/` — the
 * dataset adapters use them, and dataset must not import viewer code.
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

export {
  planVolumePreview,
  VOLUME_PREVIEW_MAX_SLABS,
  VOLUME_PREVIEW_MAX_TILES,
  VOLUME_PREVIEW_MAX_CHUNK_TEXELS,
  VOLUME_PREVIEW_POOL_HEADROOM,
  type VolumePreviewPlan,
} from "./volume-policy";
