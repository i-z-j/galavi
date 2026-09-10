/**
 * Tile planner — enumerate the storage chunks intersecting a viewport.
 */

import type { Vec3 } from "../../state/schema";
import type { TileBounds } from "./level";

/**
 * Canonical tile identity: identifies a placement, not a fetch coordinate
 * (`TileCoord`). `coordinates` are the planner-grid coordinates the layer
 * placed the tile at (volume: `voxelPos`; slice: `[sliceIdx, ...voxelPos]`).
 */
export function tileId(level: number, coordinates: readonly number[]): string {
  return `${level}:${coordinates.join(",")}`;
}

/**
 * A tile placed at a planner grid cell. Carries the load `id`, its grid
 * index, voxel-space position, and pyramid level. Concrete layers may
 * extend `T` with extra fields they need at fetch time.
 */
export interface TilePlacement {
  id        : string;
  gridIdx   : number;
  voxelPos  : number[];
  level     : number;
  chunkSize : Vec3;
  region    : { start: Vec3; size: Vec3 };
}

export interface TilePlan<T extends TilePlacement> {
  /** Pyramid level represented by this plan, including empty plans. */
  level           : number;
  /** Visible viewport origin in normalized data-space (length = gridDim). */
  viewportOrigin  : number[];
  /** Visible viewport size in normalized data-space (length = gridDim). */
  viewportSize    : number[];
  /** First visible storage-chunk coordinate (length = gridDim). */
  gridOrigin      : number[];
  /** Visible storage-chunk count per axis (length = gridDim). */
  gridShape       : number[];
  /** Per-axis tile size in normalized [0,1] (length = gridDim). */
  tileNormSize    : number[];
  /** Generated visible tile descriptors, x-fastest. */
  tiles           : T[];
  /** Dimensionality of the visible grid. */
  gridDim         : 2 | 3;
}

/**
 * Plan every storage chunk intersecting normalized viewport bounds.
 * `makeTile` can remap view axes and attach layer-specific request metadata.
 */
export function planTiles<T extends TilePlacement>(opts: {
  bounds      : TileBounds;
  chunkSize   : readonly number[];
  resSize     : readonly number[];
  gridDim     : 2 | 3;
  level       : number;
  /** Construct a tile placement; layer can attach extra fields. */
  makeTile    : (
    gridIdx  : number,
    voxelPos : number[],
    level    : number,
    region   : { start: number[]; size: number[] },
  ) => T;
}): TilePlan<T> {
  const { bounds, chunkSize, resSize, gridDim, level, makeTile } = opts;
  const tileNormSize  = new Array<number>(gridDim);
  const gridOrigin    = new Array<number>(gridDim);
  const gridShape     = new Array<number>(gridDim);
  const viewportOrigin = new Array<number>(gridDim);
  const viewportSize   = new Array<number>(gridDim);
  for (let axis = 0; axis < gridDim; axis++) {
    const size        = Math.max(1, resSize[axis]);
    const chunk       = Math.max(1, chunkSize[axis]);
    const lower       = Math.max(0, Math.min(1, bounds.min[axis] ?? 0));
    const upper       = Math.max(lower, Math.min(1, bounds.max[axis] ?? 1));
    const firstChunk  = Math.floor((lower * size) / chunk);
    const intersects  = upper > lower;
    const lastChunk   = intersects
      ? Math.max(firstChunk, Math.ceil((upper * size) / chunk) - 1)
      : firstChunk - 1;
    tileNormSize[axis]  = chunk / size;
    gridOrigin[axis]    = firstChunk;
    gridShape[axis]     = Math.max(0, lastChunk - firstChunk + 1);
    viewportOrigin[axis] = lower;
    viewportSize[axis]   = upper - lower;
  }

  const tiles: T[] = [];
  if (gridDim === 3) {
    for (let z = 0; z < gridShape[2]; z++) {
      for (let y = 0; y < gridShape[1]; y++) {
        for (let x = 0; x < gridShape[0]; x++) {
          const gridIdx = z * gridShape[0] * gridShape[1] + y * gridShape[0] + x;
          const voxelPos = [
            (gridOrigin[0] + x) * chunkSize[0],
            (gridOrigin[1] + y) * chunkSize[1],
            (gridOrigin[2] + z) * chunkSize[2],
          ];
          const region = {
            start: voxelPos.map((value, axis) => value / resSize[axis]),
            size : tileNormSize.slice(),
          };
          tiles.push(makeTile(gridIdx, voxelPos, level, region));
        }
      }
    }
  } else {
    for (let y = 0; y < gridShape[1]; y++) {
      for (let x = 0; x < gridShape[0]; x++) {
        const gridIdx = y * gridShape[0] + x;
        const voxelPos = [
          (gridOrigin[0] + x) * chunkSize[0],
          (gridOrigin[1] + y) * chunkSize[1],
        ];
        const region = {
          start: voxelPos.map((value, axis) => value / resSize[axis]),
          size : tileNormSize.slice(),
        };
        tiles.push(makeTile(gridIdx, voxelPos, level, region));
      }
    }
  }

  return {
    level,
    viewportOrigin,
    viewportSize,
    gridOrigin,
    gridShape,
    tileNormSize,
    tiles,
    gridDim,
  };
}
