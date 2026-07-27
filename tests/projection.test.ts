import { describe, expect, test } from "vitest";
import type { Camera, State } from "../src/types";
import type { AxisMap } from "../src/utils/axes";
import {
  physicalToSliceScreen,
  physicalToVolumeScreen,
  screenToSlicePhysical,
  sliceUnitsPerPixel,
  volumeUnitsPerPixel,
} from "../src/utils/projection";

const DEFAULT_FOV = Math.PI / 4;
const HALF_FOV_TAN = Math.tan(DEFAULT_FOV / 2);

function sliceState(distance: number): State {
  return {
    layers: [],
    exploration: {
      camera: {
        navMode: "orbit",
        projMode: "orthographic",
        position: [0.5, 0.5, 0.5 + distance],
        target: [0.5, 0.5, 0.5],
      },
    },
  };
}

const AXIS_MAP: AxisMap = [0, 1, 2];

describe("physicalToSliceScreen", () => {
  test("maps the camera target to the viewport center", () => {
    expect(physicalToSliceScreen([0.5, 0.5, 0.5], sliceState(2), AXIS_MAP, 200, 100))
      .toEqual([100, 50]);
  });

  test("maps offsets through the ortho half-extent and aspect", () => {
    // distance 2 → halfExtent 1; aspect 2 → visible half-width 2
    expect(physicalToSliceScreen([2.5, 0.5, 0.5], sliceState(2), AXIS_MAP, 200, 100))
      .toEqual([200, 50]);
    expect(physicalToSliceScreen([0.5, 1.5, 0.5], sliceState(2), AXIS_MAP, 200, 100))
      .toEqual([100, 100]);
  });

  test("respects the axis map", () => {
    const axisMap: AxisMap = [2, 1, 0];
    expect(physicalToSliceScreen([0.5, 0.5, 2.5], sliceState(2), axisMap, 200, 100))
      .toEqual([200, 50]);
  });
});

describe("screenToSlicePhysical", () => {
  test("is the inverse of physicalToSliceScreen on the plane", () => {
    const state = sliceState(2);
    const physical = screenToSlicePhysical(200, 50, state, AXIS_MAP, 200, 100, 0.25);
    expect(physical[0]).toBeCloseTo(2.5);
    expect(physical[1]).toBeCloseTo(0.5);
    expect(physical[2]).toBeCloseTo(0.25);
  });
});

describe("sliceUnitsPerPixel", () => {
  test("is the visible height divided by viewport height", () => {
    // visible height = camera distance (2 × halfExtent)
    expect(sliceUnitsPerPixel(sliceState(2), 100)).toBeCloseTo(0.02);
  });
});

const volumeCamera: Camera = {
  navMode: "orbit",
  projMode: "perspective",
  position: [0, 0, 5],
  target: [0, 0, 0],
};

describe("physicalToVolumeScreen", () => {
  test("maps the target to the viewport center", () => {
    expect(physicalToVolumeScreen([0, 0, 0], volumeCamera, 200, 100)).toEqual([100, 50]);
  });

  test("returns null for points behind the camera", () => {
    expect(physicalToVolumeScreen([0, 0, 10], volumeCamera, 200, 100)).toBeNull();
  });

  test("offsets project symmetrically", () => {
    const right = physicalToVolumeScreen([1, 0, 0], volumeCamera, 200, 100);
    const left = physicalToVolumeScreen([-1, 0, 0], volumeCamera, 200, 100);
    expect(right).not.toBeNull();
    expect(left).not.toBeNull();
    expect(right![0] - 100).toBeCloseTo(100 - left![0]);
    expect(right![1]).toBeCloseTo(50);
  });
});

describe("volumeUnitsPerPixel", () => {
  test("matches the perspective frustum at the target plane", () => {
    expect(volumeUnitsPerPixel(volumeCamera, 100)).toBeCloseTo(2 * 5 * HALF_FOV_TAN / 100);
  });
});
