/**
 * Volume preview policy — automatic tile budgets for pathological pyramids
 * (DX-M4).
 *
 * Volume layers keep every z slab of the chosen level resident. Stores with
 * z-chunk = 1 and no z downsampling (e.g. IDR0066: 1937 slabs of 256×256
 * chunks; idr0048A: 1402 slabs at *every* level) turn that into thousands of
 * slow single-slab requests and multi-GB pool textures — the viewer never
 * settles.
 *
 * `planVolumePreview` detects that shape from pyramid/chunk metadata alone
 * and derives a bounded preview: a z-strided virtual pyramid where each
 * virtual slab is one real fetch, keeping only levels whose tile count and
 * chunk texels stay within the budgets below. The result plugs into the same
 * pyramid/fetch pipeline as an unmodified source, so level selection, tile
 * planning, and pool sizing need no special cases. Well-behaved pyramids get
 * `null` and render exactly as before.
 *
 * The budgets are renderer policy (request count and GPU residency), not
 * format knowledge — they live in core, not in adapters. They are policy
 * constants, not GPU-derived; the TilePool still clamps the final allocation
 * to device limits.
 *
 * The policy needs a `fetch` function to remap virtual slab coordinates back
 * onto the real pyramid; urlTemplate-only sources cannot be strided and are
 * left untouched.
 */

import type { Data, ImagePyramid, ImagePyramidLevel } from "../../types";

/** Maximum virtual z slabs per kept preview level. */
export const VOLUME_PREVIEW_MAX_SLABS = 384;
/** Maximum total tiles (xy chunks × virtual slabs) per kept preview level. */
export const VOLUME_PREVIEW_MAX_TILES = 1296;
/** Maximum texels per storage chunk for a kept non-coarsest level. */
export const VOLUME_PREVIEW_MAX_CHUNK_TEXELS = 512 * 512;
/**
 * Extra pool slots beyond the largest preview level's tile set, so the level
 * picker (`tileBudget = pool.capacity - 1`) can always hold a full level.
 */
export const VOLUME_PREVIEW_POOL_HEADROOM = 64;

/**
 * A bounded preview for a pathological volume pyramid: a strided virtual
 * pyramid, the largest tile count across its levels (for pool sizing), and a
 * fetch wrapper mapping virtual coordinates back onto the real pyramid.
 */
export interface VolumePreviewPlan {
  /** Virtual pyramid: kept levels with strided z grids (chunk z = 1). */
  pyramid  : ImagePyramid;
  /** Largest full-grid tile count across virtual levels (pool sizing). */
  maxTiles : number;
  /** Wrap a real fetch so it serves virtual level/slab coordinates. */
  wrapFetch(fetch: NonNullable<Data["fetch"]>): NonNullable<Data["fetch"]>;
}

/**
 * Derive a bounded preview for a z-chunk=1-style pathological pyramid, or
 * return `null` when the pyramid is well-behaved (no level with z-chunk = 1
 * and more slabs than {@link VOLUME_PREVIEW_MAX_SLABS}) — callers must leave
 * the source untouched in that case.
 */
export function planVolumePreview(pyramid: ImagePyramid): VolumePreviewPlan | null {
  const levels = pyramid.levels;
  if (levels.length === 0) return null;
  const slabCount = (l: ImagePyramidLevel) =>
    Math.ceil(l.shape[2] / Math.max(1, l.chunkSize[2]));
  const pathological = levels.some(
    (l) => l.chunkSize[2] === 1 && slabCount(l) > VOLUME_PREVIEW_MAX_SLABS,
  );
  if (!pathological) return null;

  const kept: { level: number; stride: number; def: ImagePyramidLevel }[] = [];
  levels.forEach((l, i) => {
    const isCoarsest = i === levels.length - 1;
    const texels = l.chunkSize[0] * l.chunkSize[1] * Math.max(1, l.chunkSize[2]);
    const chunksXY =
      Math.ceil(l.shape[0] / Math.max(1, l.chunkSize[0])) *
      Math.ceil(l.shape[1] / Math.max(1, l.chunkSize[1]));
    const stride = Math.max(1, Math.ceil(slabCount(l) / VOLUME_PREVIEW_MAX_SLABS));
    const virtualSlabs = Math.ceil(slabCount(l) / stride);
    // The coarsest level is always kept as a fallback; finer levels must
    // stay within the pool-slot and total-tile budgets.
    if (!isCoarsest && (texels > VOLUME_PREVIEW_MAX_CHUNK_TEXELS || chunksXY * virtualSlabs > VOLUME_PREVIEW_MAX_TILES)) return;
    kept.push({
      level: i,
      stride,
      def: {
        ...l,
        shape: [l.shape[0], l.shape[1], virtualSlabs],
        chunkSize: [l.chunkSize[0], l.chunkSize[1], 1],
      },
    });
  });

  const maxTiles = Math.max(
    ...kept.map((k) => {
      const d = k.def;
      return (
        Math.ceil(d.shape[0] / Math.max(1, d.chunkSize[0])) *
        Math.ceil(d.shape[1] / Math.max(1, d.chunkSize[1])) *
        Math.ceil(d.shape[2] / Math.max(1, d.chunkSize[2]))
      );
    }),
  );

  const wrapFetch: VolumePreviewPlan["wrapFetch"] = (fetch) => (req) => {
    if (!req) return fetch(req);
    const k = kept[req.level ?? 0];
    const pos = req.position ?? [0, 0, 0];
    const realChunkZ = Math.max(1, levels[k.level].chunkSize[2]);
    return fetch({
      ...req,
      level: k.level,
      position: [pos[0], pos[1], pos[2] * k.stride * realChunkZ],
    });
  };

  return { pyramid: { ...pyramid, levels: kept.map((k) => k.def) }, maxTiles, wrapFetch };
}
