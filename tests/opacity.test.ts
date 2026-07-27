/**
 * Opacity propagation regression tests (finding C1).
 *
 * `render.opacity` from state was silently ignored by points / vectors /
 * tracks / network / segmentation: their `getParams()` returned stale params.
 * The fix syncs `BaseLayer.opacity` into the params in the `getParams()`
 * wrapper — these tests pin that contract for the five affected layer types.
 */
import { describe, expect, test } from "vitest";
import type { BaseLayer } from "../src/layer";
import { layerRegistry } from "../src/registry";
import type { LayerConfig } from "../src/types";

const AFFECTED_TYPES = ["points", "vectors", "tracks", "network", "segmentation"] as const;

function createLayer(type: string, options?: Record<string, unknown>): BaseLayer {
  const desc: LayerConfig = { id: `test-${type}`, type, options };
  return layerRegistry.create(type, desc.id, desc);
}

function paramsOpacity(layer: BaseLayer): number {
  return (layer.getParams() as unknown as { opacity: number }).opacity;
}

describe("render.opacity propagation (C1)", () => {
  for (const type of AFFECTED_TYPES) {
    test(`${type}: constructor opacity reaches the params`, () => {
      const layer = createLayer(type, { opacity: 0.3 });
      expect(paramsOpacity(layer)).toBe(0.3);
    });

    test(`${type}: applyConfig render.opacity reaches the params`, () => {
      const layer = createLayer(type);
      layer.applyConfig({ id: layer.id, type, render: { opacity: 0.5 } });
      expect(paramsOpacity(layer)).toBe(0.5);
      expect(layer.getParams().toBuffer()).toBeInstanceOf(Float32Array);
    });
  }

  test("segmentation: default 0.7 opacity is preserved when none is configured", () => {
    const layer = createLayer("segmentation");
    expect(paramsOpacity(layer)).toBe(0.7);
  });

  test("opacity updates are cumulative across config applications", () => {
    const layer = createLayer("points", { points: [[0, 0, 0]] });
    layer.applyConfig({ id: layer.id, type: "points", render: { opacity: 0.5 } });
    layer.applyConfig({ id: layer.id, type: "points", render: { opacity: 0.9 } });
    expect(paramsOpacity(layer)).toBe(0.9);
  });
});
