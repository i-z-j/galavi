/**
 * Anatomical orientation — RAS-style axis metadata → storage axis maps.
 *
 * Biomedical datasets describe how storage axes (x/y/z) map to anatomical
 * axes (R/L = left-right, A/P = anterior-posterior, S/I = superior-inferior)
 * via a `RAS_coordinate` direction string and an `axes_order` permutation.
 * These helpers parse that metadata into axis maps and slice-plane
 * orientations for canonical 2D views.
 */

import type { AxisMap } from "./axes";

export type StorageAxis        = 0 | 1 | 2;
export type StorageAxisName    = "x" | "y" | "z";
export type AnatomicalAxis     = "R" | "A" | "S";
export type AnatomicalDirection = "R" | "r" | "A" | "a" | "S" | "s";
export type OrientationSign    = 1 | -1;
export type SlicePlane         = "xy" | "yz" | "xz";

export interface OrientedSlicePlane {
  axes        : [StorageAxisName, StorageAxisName];
  axisMap     : AxisMap;
  sourcePlane : SlicePlane;
  reversed    : [boolean, boolean, boolean];
}

export interface OrientedAxis {
  storageAxis : StorageAxis;
  storageName : StorageAxisName;
  sign        : OrientationSign;
}

export interface AnatomicalOrientation {
  R : OrientedAxis;
  A : OrientedAxis;
  S : OrientedAxis;
}

const STORAGE_AXIS: Record<StorageAxisName, StorageAxis> = { x: 0, y: 1, z: 2 };
const PLANE_AXES: Record<SlicePlane, [AnatomicalAxis, AnatomicalAxis, AnatomicalAxis]> = {
  xy: ["R", "S", "A"],
  xz: ["R", "A", "S"],
  yz: ["A", "S", "R"],
};

export function parseAnatomicalOrientation(
  rasCoordinate : string,
  axesOrder     : string,
): AnatomicalOrientation {
  if (!/^[RrAaSs]{3}$/.test(rasCoordinate)) {
    throw new Error(`Invalid RAS_coordinate: ${rasCoordinate}`);
  }

  const rawAxes = axesOrder.toLowerCase();
  if (rawAxes.length !== 3 || new Set(rawAxes).size !== 3 || !/^[xyz]{3}$/.test(rawAxes)) {
    throw new Error(`Invalid axes_order: ${axesOrder}`);
  }

  const orientation = {} as AnatomicalOrientation;
  for (let rawAxis = 0; rawAxis < 3; rawAxis++) {
    const direction      = rasCoordinate[rawAxis] as AnatomicalDirection;
    const anatomicalAxis = direction.toUpperCase() as AnatomicalAxis;
    if (orientation[anatomicalAxis]) {
      throw new Error(`Invalid RAS_coordinate: ${rasCoordinate}`);
    }
    const storageName = rawAxes[rawAxis] as StorageAxisName;
    orientation[anatomicalAxis] = {
      storageAxis : STORAGE_AXIS[storageName],
      storageName,
      sign        : direction === anatomicalAxis ? 1 : -1,
    };
  }

  if (!orientation.R || !orientation.A || !orientation.S) {
    throw new Error(`Invalid RAS_coordinate: ${rasCoordinate}`);
  }
  return orientation;
}

export function buildSliceOrientations(
  rasCoordinate : string,
  axesOrder     : string,
): Record<SlicePlane, OrientedSlicePlane> {
  const orientation = parseAnatomicalOrientation(rasCoordinate, axesOrder);

  return Object.fromEntries(
    (Object.entries(PLANE_AXES) as [SlicePlane, [AnatomicalAxis, AnatomicalAxis, AnatomicalAxis]][])
      .map(([plane, anatomicalAxes]) => {
        const orientedAxes = anatomicalAxes.map((axis) => orientation[axis]) as [OrientedAxis, OrientedAxis, OrientedAxis];
        const axisMap      = orientedAxes.map((axis) => axis.storageAxis) as AxisMap;
        return [plane, {
          axes        : [orientedAxes[0].storageName, orientedAxes[1].storageName],
          axisMap,
          sourcePlane : sourcePlaneForSliceAxis(axisMap[2]),
          reversed    : orientedAxes.map((axis) => axis.sign === 1) as [boolean, boolean, boolean],
        }];
      }),
  ) as Record<SlicePlane, OrientedSlicePlane>;
}

export function canonicalToStorageIndex(index: number, count: number, reversed: boolean): number {
  const size    = Math.max(1, Math.round(count));
  const clamped = Math.max(0, Math.min(size - 1, Math.round(index)));
  return reversed ? size - 1 - clamped : clamped;
}

function sourcePlaneForSliceAxis(axis: StorageAxis): SlicePlane {
  if (axis === 0) return "yz";
  if (axis === 1) return "xz";
  return "xy";
}
