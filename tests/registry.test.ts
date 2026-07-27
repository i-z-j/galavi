/**
 * Registry tests — known types resolve, unknown types throw, custom
 * registrations can be added and removed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { PointsLayer } from "../src/layer";
import { layerRegistry, registerLayer } from "../src/registry";

describe("layerRegistry", () => {
  afterEach(() => {
    layerRegistry.unregister("custom-points");
  });

  test("creates a known layer type", () => {
    const layer = layerRegistry.create("points", "p1", { id: "p1", type: "points" });
    expect(layer).toBeInstanceOf(PointsLayer);
    expect(layer.id).toBe("p1");
  });

  test("throws `Unknown type` for an unregistered type", () => {
    expect(() => layerRegistry.create("nope", "x", { id: "x", type: "nope" }))
      .toThrow('Unknown type: "nope"');
  });

  test("registers and creates a custom type", () => {
    expect(layerRegistry.has("custom-points")).toBe(false);
    registerLayer("custom-points", (id) => new PointsLayer(id));
    expect(layerRegistry.has("custom-points")).toBe(true);
    expect(layerRegistry.keys()).toContain("custom-points");

    const layer = layerRegistry.create("custom-points", "c1", { id: "c1", type: "custom-points" });
    expect(layer).toBeInstanceOf(PointsLayer);

    expect(layerRegistry.unregister("custom-points")).toBe(true);
    expect(layerRegistry.has("custom-points")).toBe(false);
  });
});
