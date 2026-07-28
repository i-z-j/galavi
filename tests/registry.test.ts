/**
 * Registry tests — known types resolve, unknown types throw, custom
 * registrations can be added and removed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { PointsLayer } from "../src/layer";
import {
  layerRegistry,
  registerLayer,
  registerSource,
  sourceRegistry,
} from "../src/registry";

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

describe("sourceRegistry", () => {
  afterEach(() => {
    sourceRegistry.unregister("custom-source");
  });

  test("registers and creates a source factory, resolves its promise", async () => {
    expect(sourceRegistry.has("custom-source")).toBe(false);
    registerSource("custom-source", async (desc) => ({
      selection: { c: Number(desc.channel ?? 0) },
    }));
    expect(sourceRegistry.has("custom-source")).toBe(true);
    expect(sourceRegistry.keys()).toContain("custom-source");

    const resolved = await sourceRegistry.create("custom-source", {
      type    : "custom-source",
      channel : 2,
    });
    expect(resolved).toEqual({ selection: { c: 2 } });

    expect(sourceRegistry.unregister("custom-source")).toBe(true);
    expect(sourceRegistry.has("custom-source")).toBe(false);
  });

  test("throws `Unknown type` for an unregistered type", () => {
    expect(() => sourceRegistry.create("nope", { type: "nope" }))
      .toThrow('Unknown type: "nope"');
  });
});
