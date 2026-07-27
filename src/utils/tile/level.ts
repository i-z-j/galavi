/**
 * Pyramid level selection — pick the coarsest useful level for the display.
 */

import type { ImagePyramid, ImagePyramidLevel } from "../../types";

export interface TileBounds {
  /** Inclusive lower bound in normalized data coordinates. */
  min: number[];
  /** Exclusive upper bound in normalized data coordinates. */
  max: number[];
}

export interface PyramidLevelSelection {
  /** Physical world units represented by one display pixel. */
  worldUnitsPerPixel: number;
  /** Spatial XYZ axes visible in this view, in view-coordinate order. */
  axes: readonly (0 | 1 | 2)[];
  /** Previously selected automatic level for view-local hysteresis. */
  currentLevel?: number;
  /** Fractional boundary margin (default 0.15). */
  hysteresis?: number;
  /** Visible normalized data bounds, in the same order as `axes`. */
  bounds?: TileBounds;
  /** Maximum number of simultaneously visible storage chunks. */
  tileBudget?: number;
}

/** Count storage chunks intersecting normalized bounds at one pyramid level. */
export function countPyramidLevelTiles(
  level  : ImagePyramidLevel,
  axes   : readonly (0 | 1 | 2)[],
  bounds : TileBounds,
): number {
  let count = 1;
  for (let index = 0; index < axes.length; index++) {
    const axis       = axes[index];
    const shape      = Math.max(1, level.shape[axis]);
    const chunkSize  = Math.max(1, level.chunkSize[axis]);
    const lower      = Math.max(0, Math.min(1, bounds.min[index] ?? 0));
    const upper      = Math.max(lower, Math.min(1, bounds.max[index] ?? 1));
    if (upper <= lower) return 0;
    const firstChunk = Math.floor((lower * shape) / chunkSize);
    const lastChunk  = Math.max(firstChunk, Math.ceil((upper * shape) / chunkSize) - 1);
    count *= lastChunk - firstChunk + 1;
  }
  return count;
}

/**
 * Select the coarsest useful pyramid level for the current display.
 *
 * A level is useful while each visible-axis voxel projects to at most one
 * display pixel. This avoids loading resolution the canvas cannot show. If
 * that level's visible chunks exceed the cache budget, progressively coarser
 * levels are considered until the complete visible set fits.
 */
export function pickPyramidLevel(
  pyramid   : ImagePyramid,
  selection : PyramidLevelSelection,
): number {
  if (pyramid.levels.length === 0) {
    throw new Error("Image pyramid must contain at least one level");
  }

  const worldUnitsPerPixel = Math.max(selection.worldUnitsPerPixel, Number.EPSILON);
  const levelMetric = (index: number): number => Math.max(
    ...selection.axes.map((axis) => pyramid.levels[index].scale[axis]),
  );
  const currentLevel = selection.currentLevel;
  let bestLevel: number;
  if (
    currentLevel !== undefined &&
    Number.isInteger(currentLevel) &&
    currentLevel >= 0 &&
    currentLevel < pyramid.levels.length
  ) {
    const margin = Math.max(0, selection.hysteresis ?? 0.15);
    bestLevel = currentLevel;
    while (
      bestLevel > 0 &&
      levelMetric(bestLevel) > worldUnitsPerPixel * (1 + margin)
    ) {
      bestLevel--;
    }
    while (
      bestLevel < pyramid.levels.length - 1 &&
      levelMetric(bestLevel + 1) <= worldUnitsPerPixel / (1 + margin)
    ) {
      bestLevel++;
    }
  } else {
    bestLevel = 0;
    for (let index = 0; index < pyramid.levels.length; index++) {
      if (levelMetric(index) <= worldUnitsPerPixel * (1 + 1e-6)) {
        bestLevel = index;
      }
    }
  }

  const budget = selection.tileBudget;
  const bounds = selection.bounds;
  if (budget === undefined || !bounds) return bestLevel;

  for (let index = bestLevel; index < pyramid.levels.length; index++) {
    if (countPyramidLevelTiles(pyramid.levels[index], selection.axes, bounds) <= budget) {
      return index;
    }
  }
  return pyramid.levels.length - 1;
}
