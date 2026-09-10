/**
 * Tile source — adapts a tiled dataset (`Data`) to fetchable tile requests.
 */

import type { Data } from "../../state/schema";
import { resolveDataUrl } from "../../utils/data-source";

export interface TileCoord {
  level     : number;
  position  : number[]; // [x, y] for 2D, [x, y, z] for 3D
  signal?   : AbortSignal;
}

export function buildTileFetcher(
  source    : Data,
  selection : Record<string, number> = {},
): (coord: TileCoord) => Promise<ArrayBuffer> {
  if (source.fetch) {
    return (coord) => {
      assertValidLevel(coord.level);
      return source.fetch!({
        level     : coord.level,
        position  : coord.position,
        selection,
        signal    : coord.signal,
      });
    };
  }

  return async (coord) => {
    assertValidLevel(coord.level);
    const url   = buildTileUrl(source, coord, selection);
    const resp  = await fetch(url, { signal: coord.signal });
    if (!resp.ok) throw new Error(`Tile fetch failed: ${resp.status}`);
    return resp.arrayBuffer();
  };
}

/**
 * Pyramid levels written into URL templates must be valid non-negative integers.
 */
function assertValidLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0) {
    throw new Error(`Invalid pyramid level: ${level}. Must be a non-negative integer.`);
  }
}

function buildTileUrl(
  source    : Data,
  coord     : TileCoord,
  selection : Record<string, number>,
): string {
  const [x, y, z] = coord.position;
  return resolveDataUrl(source, {
    level: coord.level,
    x,
    y,
    z: z ?? 0,
    ...selection,
  });
}
