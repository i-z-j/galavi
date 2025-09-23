export type AxisIndex = 0 | 1 | 2;
export type AxisMap = [AxisIndex, AxisIndex, AxisIndex];

const AXIS_INDEX: Record<string, AxisIndex> = { x: 0, y: 1, z: 2 };

export function resolveAxes(axes: readonly (string | number)[]): AxisMap {
  if (axes.length < 2) {
    throw new Error(`[galavi] Invalid axes config: [${axes.join(",")}]`);
  }

  const uAxis = toAxisIndex(axes[0]);
  const vAxis = toAxisIndex(axes[1]);

  if (uAxis === vAxis) {
    throw new Error(`[galavi] Invalid axes config: [${axes.join(",")}]`);
  }

  const sliceAxis = [0, 1, 2].find((axis) => axis !== uAxis && axis !== vAxis);
  if (sliceAxis === undefined) {
    throw new Error(`[galavi] Invalid axes config: [${axes.join(",")}]`);
  }

  return [uAxis, vAxis, sliceAxis as AxisIndex];
}

function toAxisIndex(axis: string | number): AxisIndex {
  const resolved = typeof axis === "string" ? AXIS_INDEX[axis] : axis;
  if (resolved !== 0 && resolved !== 1 && resolved !== 2) {
    throw new Error(`[galavi] Invalid axis value: ${axis}`);
  }
  return resolved;
}