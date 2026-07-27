/**
 * Transform composition regression test.
 *
 * BaseLayer.setTransform documents M = Affine × Translate × Rotate × Scale
 * (standard TRS). wgpu-matrix post-multiplies, so the calls must be ordered
 * translate → rotate → scale; a scale-first composition silently places any
 * layer with a non-zero origin at origin ⊙ size (found via a dataset with
 * negative-origin translation rendering at origin×size, kilometers off).
 */
import { describe, expect, test } from "vitest";
import { vec4 } from "wgpu-matrix";
import {
  BaseLayer,
  MIN_VEC4_BUFFER,
  type Geometry,
  type LayerConfig,
  type LayerParams,
} from "../src/index";

class ProbeLayer extends BaseLayer {
  static readonly layerType = "probe";
  static fromConfig(name: string, _desc: LayerConfig): BaseLayer {
    return new ProbeLayer(name);
  }
  protected override shaderCode = "";
  getGeometry(): Geometry {
    return { vertices: new Float32Array(0), vertexCount: 0, vertexStride: 0, topology: "triangle-list" };
  }
  protected getLayerParams(): LayerParams {
    return { toBuffer: () => MIN_VEC4_BUFFER };
  }
}

function apply(m: Float32Array, p: [number, number, number]): number[] {
  return Array.from(vec4.transformMat4([...p, 1], m)).slice(0, 3);
}

describe("BaseLayer.setTransform", () => {
  test("scale + translate composes as M = T·S (local point p → s·p + t)", () => {
    const layer = new ProbeLayer("t1");
    layer.setTransform({ scale: [2, 4, 8], translate: [10, 20, 30] });

    // Local origin → translation, NOT translation ⊙ scale.
    expect(apply(layer.modelMatrix, [0, 0, 0])).toEqual([10, 20, 30]);
    // Local (1,1,1) → s·p + t.
    expect(apply(layer.modelMatrix, [1, 1, 1])).toEqual([12, 24, 38]);
  });

  test("negative origin is not scaled (the chameleon case)", () => {
    const layer = new ProbeLayer("t2");
    // Dataset-style transform: physical size as scale, negative origin.
    layer.setTransform({ scale: [94.5, 94.5, 113.4], translate: [-47.25, -47.25, -56.7] });

    const origin = apply(layer.modelMatrix, [0, 0, 0]);
    expect(origin[0]).toBeCloseTo(-47.25, 5);
    expect(origin[1]).toBeCloseTo(-47.25, 5);
    expect(origin[2]).toBeCloseTo(-56.7, 5);
    const far = apply(layer.modelMatrix, [1, 1, 1]);
    expect(far[0]).toBeCloseTo(47.25, 5);
    expect(far[2]).toBeCloseTo(56.7, 5);
  });

  test("inverse matrix round-trips", () => {
    const layer = new ProbeLayer("t3");
    layer.setTransform({ scale: [2, 2, 2], translate: [5, -3, 7], rotate: [0, 30, 0] });

    const p = apply(layer.modelMatrix, [0.25, -0.5, 1]);
    const back = apply(layer.invModelMatrix, p as [number, number, number]);
    expect(back[0]).toBeCloseTo(0.25, 4);
    expect(back[1]).toBeCloseTo(-0.5, 4);
    expect(back[2]).toBeCloseTo(1, 4);
  });

  test("explicit affine is applied verbatim; undefined resets to identity", () => {
    const layer = new ProbeLayer("t4");
    const affine = new Float32Array(16).fill(0);
    affine[0] = affine[5] = affine[10] = affine[15] = 1;
    affine[12] = 42;
    layer.setTransform({ affine: Array.from(affine) });
    expect(apply(layer.modelMatrix, [0, 0, 0])[0]).toBe(42);

    layer.setTransform(undefined);
    expect(apply(layer.modelMatrix, [1, 2, 3])).toEqual([1, 2, 3]);
  });
});
