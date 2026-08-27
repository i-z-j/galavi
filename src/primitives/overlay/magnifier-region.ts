import { mat4 } from "wgpu-matrix";
import type { ImagePyramid, Vec3 } from "../../state/schema";

export interface MagnifierRegion {
  /** Level-0 voxel origin after sliding the fixed-size region inside the data. */
  finestOrigin    : Vec3;
  /** Level-0 voxel count after applying the configured physical and voxel caps. */
  finestShape     : Vec3;
  /** Effective physical side length along each source axis. */
  worldSize       : Vec3;
  /** Effective center after edge sliding, in world coordinates. */
  worldCenter     : Vec3;
  /** Effective source-local normalized crop rendered by tiled layers. */
  normalizedBounds: { min: Vec3; max: Vec3 };
}

export function computeMagnifierVoxelRegion(opts: {
  pyramid     : ImagePyramid;
  model       : Float32Array;
  position    : Vec3;
  voxelExtent : number;
}): MagnifierRegion {
  const finest = opts.pyramid.levels[0];
  if (!finest) throw new Error("Magnifier region requires a non-empty pyramid");

  const voxelExtent = Math.max(1, Math.round(opts.voxelExtent));
  const sourceCenter = transformPoint(mat4.inverse(opts.model), opts.position);
  const voxelSize = [0, 1, 2].map((axis) => (
    Math.max(Number.EPSILON, modelAxisLength(opts.model, axis) / Math.max(1, finest.shape[axis]))
  )) as Vec3;
  const finestShape = finest.shape.map((shape) => (
    Math.min(voxelExtent, Math.max(1, shape))
  )) as Vec3;
  const centerVoxel = sourceCenter.map((value, axis) => value * finest.shape[axis]) as Vec3;
  const finestOrigin = centerVoxel.map((center, axis) => {
    const count = finestShape[axis];
    const start = Math.round(center - count / 2);
    return Math.max(0, Math.min(finest.shape[axis] - count, start));
  }) as Vec3;
  const normalizedBounds = {
    min: finestOrigin.map((origin, axis) => origin / finest.shape[axis]) as Vec3,
    max: finestOrigin.map((origin, axis) => (
      (origin + finestShape[axis]) / finest.shape[axis]
    )) as Vec3,
  };
  const normalizedCenter = normalizedBounds.min.map((value, axis) => (
    (value + normalizedBounds.max[axis]) / 2
  )) as Vec3;

  return {
    finestOrigin,
    finestShape,
    worldSize: finestShape.map((count, axis) => count * voxelSize[axis]) as Vec3,
    worldCenter: transformPoint(opts.model, normalizedCenter),
    normalizedBounds,
  };
}

function modelAxisLength(model: Float32Array, axis: number): number {
  const offset = axis * 4;
  return Math.hypot(model[offset], model[offset + 1], model[offset + 2]);
}

function transformPoint(matrix: Float32Array, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8]  * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9]  * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}