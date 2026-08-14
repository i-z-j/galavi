/**
 * Registry tests — known types resolve, unknown types throw, custom
 * registrations can be added and removed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { PointsLayer } from "../src/layer";
import {
  Dataset,
  type DatasetDefaults,
} from "../src/dataset";
import {
  datasetRegistry,
  layerRegistry,
  registerDataset,
  registerLayer,
} from "../src/registry";
import type { LayerConfig } from "../src/types";

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

class StubDataset extends Dataset {
  override async load(): Promise<void> {}
  override dispose(): void {}
  override deriveDefaults(): DatasetDefaults {
    return { mode: "slice", selection: {} };
  }
  override createDefaultLayers(): LayerConfig[] {
    return [];
  }
}

describe("datasetRegistry", () => {
  afterEach(() => {
    datasetRegistry.unregister("custom-dataset");
  });

  test("registers and creates a dataset kind", () => {
    expect(datasetRegistry.has("custom-dataset")).toBe(false);
    registerDataset("custom-dataset", (config) => new StubDataset(config));
    expect(datasetRegistry.has("custom-dataset")).toBe(true);
    expect(datasetRegistry.keys()).toContain("custom-dataset");

    const dataset = datasetRegistry.create("custom-dataset", {
      type   : "custom-dataset",
      source : "mem://x",
    });
    expect(dataset).toBeInstanceOf(StubDataset);
    expect(dataset.type).toBe("custom-dataset");
    expect(dataset.config.source).toBe("mem://x");

    expect(datasetRegistry.unregister("custom-dataset")).toBe(true);
    expect(datasetRegistry.has("custom-dataset")).toBe(false);
  });

  test("throws `Unknown type` for an unregistered kind", () => {
    expect(() => datasetRegistry.create("nope", { type: "nope" }))
      .toThrow('Unknown type: "nope"');
  });
});
