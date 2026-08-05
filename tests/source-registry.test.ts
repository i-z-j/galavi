/**
 * Source registry + JSON-portable state tests.
 *
 * A layer whose `data.source` descriptor is set (without explicit
 * `pyramid`/`fetch`) resolves it asynchronously through `sourceRegistry`.
 * The resolved artifacts live on the layer instance only — `getState()`
 * keeps the descriptor as the canonical, JSON-serializable form.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createGalavi, type Galavi } from "../src/index";
import { VolumeLayer } from "../src/layer";
import {
  registerSource,
  sourceRegistry,
  type ResolvedSource,
} from "../src/registry";
import type {
  ImagePyramid,
  SourceDescriptor,
  State,
} from "../src/types";

const SOURCE_TYPE = "fake-source";

const PYRAMID: ImagePyramid = {
  levels: [
    { path: "0", shape: [8, 8, 8], chunkSize: [4, 4, 4], scale: [1, 1, 1] },
    { path: "1", shape: [4, 4, 4], chunkSize: [4, 4, 4], scale: [2, 2, 2] },
  ],
};

const DESC: SourceDescriptor = { type: SOURCE_TYPE, url: "mem://dataset", channel: 1 };

const fakeFetch = async () => new ArrayBuffer(0);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Flush the microtask queue so descriptor .then/.catch handlers run. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeVolumeLayer(data: State["layers"][number]["data"]): VolumeLayer {
  return VolumeLayer.fromConfig("v", { id: "v", type: "volume", data });
}

describe("Data.source descriptor resolution", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    sourceRegistry.unregister(SOURCE_TYPE);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("resolves a descriptor end-to-end: readiness, versions, tile flow", async () => {
    const d = deferred<ResolvedSource>();
    registerSource(SOURCE_TYPE, () => d.promise);

    const layer = makeVolumeLayer({ source: DESC });
    expect(layer.isReady).toBe(false);
    expect(layer.getTileSpec()).toBeNull();
    const dataVersion     = layer.dataVersion;
    const geometryVersion = layer.geometryVersion;

    d.resolve({ pyramid: PYRAMID, fetch: fakeFetch });
    await flush();

    // Readiness flips, data identity + pipeline-structure versions bump.
    expect(layer.isReady).toBe(true);
    expect(layer.dataVersion).toBeGreaterThan(dataVersion);
    expect(layer.geometryVersion).toBeGreaterThan(geometryVersion);

    // The tiled pipeline flows unchanged against the resolved artifacts.
    const spec = layer.getTileSpec();
    expect(spec).not.toBeNull();
    expect(spec?.slotSize).toEqual([4, 4, 4]);

    const frame = layer.planTiles({
      bounds             : { min: [0, 0, 0], max: [1, 1, 1] },
      worldUnitsPerPixel : 1,
      tileBudget         : 64,
    });
    expect(frame).not.toBeNull();
    await expect(
      frame!.loader.fetch(frame!.plan.tiles[0], new AbortController().signal),
    ).resolves.toBeInstanceOf(ArrayBuffer);

    // Resolved artifacts are reachable for apps, but never enter the source.
    expect(layer.getResolvedSource()?.pyramid).toBe(PYRAMID);
  });

  test("keeps State pure JSON: descriptor survives, artifacts stay on the layer", async () => {
    const d = deferred<ResolvedSource>();
    registerSource(SOURCE_TYPE, () => d.promise);

    const galavi: Galavi = await createGalavi({
      state: {
        layers      : [{ id: "v", type: "volume", data: { source: DESC } }],
        exploration : {
          camera: {
            navMode  : "orbit",
            projMode : "perspective",
            position : [1.13, 0.12, 1.13],
            target   : [0.5, 0.5, 0.5],
          },
        },
      },
      views: { main: { type: "volume", layers: ["v"] } },
    });
    try {
      const layer = galavi.view("main").getLayer("v")!;
      expect(layer.isReady).toBe(false);

      let settled = false;
      const ready = galavi.view("main").whenLayerReady("v").then((l) => {
        settled = true;
        return l;
      });
      await flush();
      expect(settled).toBe(false);

      d.resolve({ pyramid: PYRAMID, fetch: fakeFetch });
      await expect(ready).resolves.toBe(layer);
      expect(settled).toBe(true);

      // getState() stays pure JSON — no resolved pyramid/fetch leaks back.
      const roundTripped = JSON.parse(JSON.stringify(galavi.getState()));
      expect(roundTripped.layers[0].data.source).toEqual(DESC);
      expect(roundTripped.layers[0].data.pyramid).toBeUndefined();
      expect(roundTripped.layers[0].data.fetch).toBeUndefined();
    } finally {
      galavi.destroy();
    }
  });

  test("explicit fetch takes precedence over the descriptor", async () => {
    const factory = vi.fn(() => Promise.resolve<ResolvedSource>({ pyramid: PYRAMID }));
    registerSource(SOURCE_TYPE, factory);

    const layer = makeVolumeLayer({ source: DESC, fetch: fakeFetch });
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(layer.isReady).toBe(true);
    expect(layer.getResolvedSource()).toBeUndefined();
  });

  test("explicit pyramid takes precedence over the descriptor", async () => {
    const factory = vi.fn(() => Promise.resolve<ResolvedSource>({ fetch: fakeFetch }));
    registerSource(SOURCE_TYPE, factory);

    const layer = makeVolumeLayer({ source: DESC, pyramid: PYRAMID });
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(layer.isReady).toBe(true);
    expect(layer.getTileSpec()).not.toBeNull();
  });

  test("a changed descriptor re-resolves; an unchanged one does not", async () => {
    const resolutions: ResolvedSource[] = [
      { pyramid: PYRAMID, fetch: fakeFetch },
      { pyramid: PYRAMID, fetch: fakeFetch, selection: { c: 3 } },
    ];
    const factory = vi.fn(async () => resolutions[factory.mock.calls.length - 1]);
    registerSource(SOURCE_TYPE, factory);

    const layer = makeVolumeLayer({ source: DESC });
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(layer.isReady).toBe(true);
    const dataVersion = layer.dataVersion;

    // Same descriptor reference → no re-resolution.
    layer.applyConfig({ id: "v", type: "volume", data: { source: DESC } });
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);

    // Changed descriptor → re-resolves, bumps dataVersion again.
    const nextDesc: SourceDescriptor = { type: SOURCE_TYPE, url: "mem://other" };
    layer.applyConfig({ id: "v", type: "volume", data: { source: nextDesc } });
    await flush();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith(nextDesc);
    expect(layer.dataVersion).toBeGreaterThan(dataVersion);
    // Resolved default selection merged (only for unset keys).
    expect(layer.getResolvedSource()?.selection).toEqual({ c: 3 });
  });

  test("resolution failure: error logged, layer stays not-ready, no throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerSource(SOURCE_TYPE, () => Promise.reject(new Error("boom")));

    const layer = makeVolumeLayer({ source: DESC });
    await flush();

    expect(layer.isReady).toBe(false);
    expect(layer.getTileSpec()).toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    const call = errorSpy.mock.calls[0];
    expect(call.some((arg) => arg instanceof Error && arg.message === "boom")).toBe(true);
    expect(call).toContainEqual(DESC);
  });

  test("unknown source type: error logged synchronously, layer stays not-ready", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const layer = makeVolumeLayer({ source: { type: "unregistered-source" } });
    await flush();

    expect(layer.isReady).toBe(false);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0][1])).toContain('Unknown type: "unregistered-source"');
  });

  test("a failing layer does not take down the Galavi instance", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerSource(SOURCE_TYPE, () => Promise.reject(new Error("boom")));

    const galavi: Galavi = await createGalavi({
      state: {
        layers: [
          { id: "v", type: "volume", data: { source: DESC } },
          { id: "p", type: "points" },
        ],
        exploration: {
          camera: {
            navMode  : "orbit",
            projMode : "perspective",
            position : [1.13, 0.12, 1.13],
            target   : [0.5, 0.5, 0.5],
          },
        },
      },
      views: { main: { type: "volume", layers: ["v", "p"] } },
    });
    try {
      await flush();
      expect(galavi.view("main").getLayer("v")!.isReady).toBe(false);
      expect(galavi.view("main").getLayer("p")!.isReady).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
      expect(() => galavi.getState()).not.toThrow();
    } finally {
      galavi.destroy();
    }
  });
});
