/**
 * Tile source — describes a tiled dataset and resolves it to fetchable URLs.
 */

import type { Data, ImagePyramid } from "../../types";

export interface TileCoord {
  level     : number;
  position  : number[]; // [x, y] for 2D, [x, y, z] for 3D
  signal?   : AbortSignal;
}

/** Tile source — describes a tiled dataset for the tile pool / loader */
export interface TileSource {
  pyramid: ImagePyramid;
  fetchTile(coord: TileCoord): Promise<ArrayBuffer>;
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

export function sourceChanged(
  next?: Data,
  prev?: Data,
): boolean {
  return (
    next?.url !== prev?.url ||
    next?.urlTemplate !== prev?.urlTemplate ||
    next?.source !== prev?.source ||
    next?.fetch !== prev?.fetch ||
    next?.pyramid !== prev?.pyramid
  );
}

/**
 * Resolve a `Data` source to a concrete URL.
 *
 * If `urlTemplate` is set, substitutes `{url}` plus every key in `vars`
 * (with values stringified). Otherwise falls back to `url`. Throws when
 * neither is defined. The single substitution path used by tile fetchers,
 * surface loaders, and shape loaders.
 */
export function resolveDataUrl(
  source  : Pick<Data, "url" | "urlTemplate">,
  vars?   : Record<string, string | number | undefined>,
): string {
  if (source.urlTemplate) {
    let url = source.urlTemplate.replace("{url}", source.url ?? "");
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) continue;
        url = url.replace(`{${key}}`, String(value));
      }
    }
    return url;
  }
  if (source.url) return source.url;
  throw new Error("DataSource must have either url, urlTemplate, or fetch");
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
