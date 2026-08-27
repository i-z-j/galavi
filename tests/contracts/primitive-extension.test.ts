/**
 * Plugin layer contract test.
 *
 * Proves a third-party layer can be written entirely against the package
 * root — BaseLayer plus the contract types Geometry / Shader / LayerParams /
 * LayerClass / MIN_VEC4_BUFFER are all exported from "src/index".
 */
import { describe, expect, test } from "vitest";
import {
  BaseLayer,
  MIN_VEC4_BUFFER,
  registerLayer,
  type Geometry,
  type LayerClass,
  type LayerConfig,
  type LayerParams,
  type Shader,
} from "../../src/index";
import { layerRegistry } from "../../src/registry";

/** Minimal plugin-style layer, written only against package-root exports. */
class MarkerLayer extends BaseLayer {
  static readonly layerType = "marker";

  static fromConfig(name: string, _desc: LayerConfig): BaseLayer {
    return new MarkerLayer(name);
  }

  protected override shaderCode = "/* wgsl would go here */";

  getGeometry(): Geometry {
    return {
      vertices     : new Float32Array(0),
      vertexCount  : 0,
      vertexStride : 0,
      topology     : "triangle-list",
    };
  }

  protected getLayerParams(): LayerParams {
    return { toBuffer: () => MIN_VEC4_BUFFER };
  }
}

// The class satisfies the static registry contract.
const markerClass: LayerClass = MarkerLayer;

describe("plugin layer contract (package root only)", () => {
  test("subclass compiles and satisfies the layer contract", () => {
    const layer = markerClass.fromConfig("m1", { id: "m1", type: "marker" });
    expect(layer).toBeInstanceOf(BaseLayer);
    expect(layer.id).toBe("m1");

    const geometry: Geometry = layer.getGeometry();
    expect(geometry.topology).toBe("triangle-list");

    const shader: Shader = layer.getShader();
    expect(shader.vertex).toBe("vs_main");
    expect(shader.fragment).toBe("fs_main");

    expect(layer.getParams().toBuffer()).toBe(MIN_VEC4_BUFFER);
  });

  test("registers via the static LayerClass contract", () => {
    registerLayer("marker", markerClass.fromConfig.bind(markerClass));
    try {
      const layer = layerRegistry.resolve("marker")("m2", { id: "m2", type: "marker" });
      expect(layer).toBeInstanceOf(MarkerLayer);
    } finally {
      layerRegistry.unregister("marker");
    }
  });
});
