/**
 * Registry tests — known types resolve, unknown types throw
 * `CapabilityResolutionError`, custom registrations can be added and removed,
 * duplicate registration throws for every capability kind, and the
 * `register*` helpers return an unregister function.
 *
 * The registries start EMPTY: the built-ins are registered by the idempotent
 * `ensureBuiltIn*()` bootstraps in each owning folder barrel (invoked by
 * `openDataset` / `createViewerRuntime` in production; called explicitly
 * here).
 */
import { afterEach, describe, expect, test } from "vitest";
import { ensureBuiltInLayers, PointsLayer } from "../../src/primitives/layer";
import {
  Dataset,
  ensureBuiltInDatasets,
} from "../../src/dataset";
import {
  CapabilityResolutionError,
  controlRegistry,
  datasetRegistry,
  layerRegistry,
  overlayRegistry,
  registerDatasetAdapter,
  registerLayer,
  viewRegistry,
} from "../../src/registry";
import { PanZoomControl } from "../../src/primitives/control";
import { RulerOverlay } from "../../src/primitives/overlay";
import { SliceView } from "../../src/primitives/view";

/** Test kinds own an exact config in the map, like any format package. */
declare module "galavi" {
  interface DatasetConfigMap {
    "custom-dataset": { type: "custom-dataset"; source: string };
  }
}

describe("layerRegistry", () => {
  afterEach(() => {
    layerRegistry.unregister("custom-points");
  });

  test("resolves a known built-in layer type (after ensureBuiltInLayers)", () => {
    ensureBuiltInLayers();
    const layer = layerRegistry.resolve("points")("p1", { id: "p1", type: "points" });
    expect(layer).toBeInstanceOf(PointsLayer);
    expect(layer.id).toBe("p1");
  });

  test("ensureBuiltInLayers is idempotent (double-invocation is a no-op)", () => {
    ensureBuiltInLayers();
    const before = layerRegistry.keys();
    ensureBuiltInLayers();
    expect(layerRegistry.keys()).toEqual(before);
  });

  test("throws CapabilityResolutionError for an unregistered type", () => {
    ensureBuiltInLayers();
    try {
      layerRegistry.resolve("nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityResolutionError);
      const capErr = err as CapabilityResolutionError;
      expect(capErr.kind).toBe("layer type");
      expect(capErr.type).toBe("nope");
      expect(capErr.available).toContain("points");
      expect(capErr.message).toContain('Unknown layer type: "nope"');
    }
  });

  test("registers and resolves a custom type; register returns an unregister function", () => {
    expect(layerRegistry.has("custom-points")).toBe(false);
    const unregister = registerLayer("custom-points", (id) => new PointsLayer(id));
    expect(layerRegistry.has("custom-points")).toBe(true);
    expect(layerRegistry.keys()).toContain("custom-points");

    const layer = layerRegistry.resolve("custom-points")("c1", { id: "c1", type: "custom-points" });
    expect(layer).toBeInstanceOf(PointsLayer);

    unregister();
    expect(layerRegistry.has("custom-points")).toBe(false);
  });

  test("duplicate registration throws, naming the key", () => {
    registerLayer("custom-points", (id) => new PointsLayer(id));
    expect(() => registerLayer("custom-points", (id) => new PointsLayer(id)))
      .toThrow(/Duplicate layer type registration: "custom-points" is already registered/);
    // The rejected duplicate did not replace or remove the original.
    expect(layerRegistry.has("custom-points")).toBe(true);
  });
});

describe("duplicate registration throws for every capability kind", () => {
  test("view / control / overlay / dataset all reject a duplicate key", () => {
    expect(() => viewRegistry.register("dup-view", (id) => new SliceView(id)))
      .not.toThrow();
    expect(() => viewRegistry.register("dup-view", (id) => new SliceView(id)))
      .toThrow(/Duplicate view type registration: "dup-view"/);
    expect(viewRegistry.unregister("dup-view")).toBe(true);

    controlRegistry.register("dup-control", (id) => new PanZoomControl(id));
    expect(() => controlRegistry.register("dup-control", (id) => new PanZoomControl(id)))
      .toThrow(/Duplicate control type registration: "dup-control"/);
    expect(controlRegistry.unregister("dup-control")).toBe(true);

    overlayRegistry.register("dup-overlay", () => new RulerOverlay());
    expect(() => overlayRegistry.register("dup-overlay", () => new RulerOverlay()))
      .toThrow(/Duplicate overlay type registration: "dup-overlay"/);
    expect(overlayRegistry.unregister("dup-overlay")).toBe(true);
  });
});

class StubDataset extends Dataset {
  override async load(): Promise<void> {}
  override dispose(): void {}
}

describe("datasetRegistry", () => {
  afterEach(() => {
    datasetRegistry.unregister("custom-dataset");
  });

  test("registers and resolves a dataset kind", () => {
    expect(datasetRegistry.has("custom-dataset")).toBe(false);
    registerDatasetAdapter("custom-dataset", (config) => new StubDataset(config));
    expect(datasetRegistry.has("custom-dataset")).toBe(true);
    expect(datasetRegistry.keys()).toContain("custom-dataset");

    const dataset = datasetRegistry.resolve("custom-dataset")({
      type   : "custom-dataset",
      source : "mem://x",
    });
    expect(dataset).toBeInstanceOf(StubDataset);
    expect(dataset.type).toBe("custom-dataset");
    expect(dataset.config.source).toBe("mem://x");

    expect(datasetRegistry.unregister("custom-dataset")).toBe(true);
    expect(datasetRegistry.has("custom-dataset")).toBe(false);
  });

  test("throws CapabilityResolutionError for an unregistered kind", () => {
    try {
      datasetRegistry.resolve("nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityResolutionError);
      expect((err as CapabilityResolutionError).kind).toBe("dataset kind");
      expect((err as CapabilityResolutionError).message).toContain('Unknown dataset kind: "nope"');
    }
  });

  test("a duplicate kind registration throws, naming the conflicting key", () => {
    registerDatasetAdapter("custom-dataset", (config) => new StubDataset(config));
    expect(() => registerDatasetAdapter("custom-dataset", (config) => new StubDataset(config)))
      .toThrow(/Duplicate dataset kind registration: "custom-dataset" is already registered/);
    // The rejected duplicate did not replace or remove the original.
    expect(datasetRegistry.has("custom-dataset")).toBe(true);
  });

  test("built-in kinds reject re-registration as well", () => {
    ensureBuiltInDatasets();
    expect(() => registerDatasetAdapter("mesh", (config) => new StubDataset(config)))
      .toThrow(/Duplicate dataset kind registration: "mesh"/);
  });

  test("registerDatasetAdapter returns an unregister function", () => {
    const unregister = registerDatasetAdapter("custom-dataset", (config) => new StubDataset(config));
    expect(datasetRegistry.has("custom-dataset")).toBe(true);
    unregister();
    expect(datasetRegistry.has("custom-dataset")).toBe(false);
  });
});
