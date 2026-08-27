/**
 * Fit-to-data camera helper tests.
 *
 * frameVolumeCamera / fitSliceCamera frame a PhysicalSpace using only public
 * camera math; verified against known inputs.
 */
import { describe, expect, test } from "vitest";
import type { PhysicalSpace } from "../../../src/state/schema";
import {
  cameraDistance,
  computePosition,
  frameVolumeCamera,
  fitSliceCamera,
} from "../../../src/utils";

const space: PhysicalSpace = {
  spatial: {
    size   : [100, 50, 20],
    origin : [10, 0, -10],
  },
};
// center = origin + size/2 = [60, 25, 0]; maxExtent = 100.

describe("frameVolumeCamera", () => {
  test("frames the space with default factor and angles", () => {
    const camera = frameVolumeCamera(space);
    expect(camera.navMode).toBe("orbit");
    expect(camera.projMode).toBe("perspective");
    expect(camera.target).toEqual([60, 25, 0]);
    expect(cameraDistance(camera)).toBeCloseTo(150, 4);
    expect(camera.position).toEqual(computePosition([60, 25, 0], 150, 0.5, -0.4));
  });

  test("honors explicit distance factor, angles, and modes", () => {
    const camera = frameVolumeCamera(space, {
      distanceFactor : 2,
      yaw            : 0,
      pitch          : 0,
      navMode        : "fly",
      projMode       : "orthographic",
    });
    expect(camera.navMode).toBe("fly");
    expect(camera.projMode).toBe("orthographic");
    expect(cameraDistance(camera)).toBeCloseTo(200, 6);
    // yaw=0, pitch=0 → straight back along +z from the target.
    expect(camera.position[0]).toBeCloseTo(60, 6);
    expect(camera.position[1]).toBeCloseTo(25, 6);
    expect(camera.position[2]).toBeCloseTo(200, 6);
  });
});

describe("fitSliceCamera", () => {
  test("frames the xy plane along +z at the in-plane max extent", () => {
    const camera = fitSliceCamera([0, 1, 2], space);
    expect(camera.navMode).toBe("fly");
    expect(camera.projMode).toBe("orthographic");
    expect(camera.target).toEqual([60, 25, 0]);
    // distance = max(size[x], size[y]) = 100, offset along the slice axis (z).
    expect(camera.position).toEqual([60, 25, 100]);
    expect(cameraDistance(camera)).toBeCloseTo(100, 6);
  });

  test("respects the axis map for u/v extents and the plane normal", () => {
    const camera = fitSliceCamera([2, 0, 1], space);
    // u=z (20), v=x (100) → distance 100, normal along y.
    expect(camera.position).toEqual([60, 125, 0]);
  });

  test("clamps degenerate planes to a minimum distance", () => {
    const flat: PhysicalSpace = { spatial: { size: [0, 0, 5] } };
    const camera = fitSliceCamera([0, 1, 2], flat);
    expect(cameraDistance(camera)).toBeCloseTo(1e-6, 9);
  });
});
