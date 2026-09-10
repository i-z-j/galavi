/**
 * Tile — tile streaming + GPU residency (viewer-side leaf module; imports
 * only `state/schema.ts` and the generic `utils/data-source.ts` helper from
 * src/).
 *
 * Split into focused modules:
 *   - source.ts   — TileCoord, buildTileFetcher
 *   - level.ts    — pickPyramidLevel, countPyramidLevelTiles, TileBounds
 *   - queue.ts    — TileLoadQueue
 *   - pool.ts     — TilePool, TilePoolConfig, TileSpec, TileViewport
 *   - planner.ts  — planTiles, tileId, TilePlacement, TilePlan
 *   - manager.ts  — TileManager, TileLoader, TileFramePlan
 *   - volume-policy.ts — planVolumePreview (automatic volume tile budgets)
 *
 * The pure encoding helpers (float16, pack) live in `utils/render/` — the
 * dataset adapters use them, and dataset must not import viewer code. The
 * generic `Data` source helpers (dataSourceChanged, resolveDataUrl) live in
 * `utils/data-source.ts` for the same reason.
 */

export {
  buildTileFetcher,
  type TileCoord,
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
  type TilePoolConfig,
  type TileSpec,
  type TileViewport,
} from "./pool";

export {
  planTiles,
  tileId,
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
