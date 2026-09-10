import { describe, expect, test, vi } from "vitest";
import { ViewPipeline } from "../../../src/primitives/view/pipeline";
import type { BaseLayer } from "../../../src/primitives/layer";

describe("ViewPipeline tiled visibility", () => {
  test("resets once and does not plan tiles while a layer is invisible", () => {
    const planTiles = vi.fn();
    const layer = {
      id: "hidden",
      visible: false,
      isReady: true,
      planTiles,
      getLevelResolution: () => 1,
    } as unknown as BaseLayer;
    const reset = vi.fn();
    const pipeline = new ViewPipeline({} as ConstructorParameters<typeof ViewPipeline>[0]);
    (pipeline as any).states.set(layer.id, {
      layer,
      tileManager: {
        pool: { capacity: 8 },
        hasVisibleTile: () => false,
        reset,
      },
      tilesActive: true,
      showingInitialTiles: false,
      lastDataVersion: 0,
    });
    const getViewport = vi.fn();

    pipeline.updateTiles([layer], getViewport);
    pipeline.updateTiles([layer], getViewport);

    expect(reset).toHaveBeenCalledOnce();
    expect(planTiles).not.toHaveBeenCalled();
    expect(getViewport).not.toHaveBeenCalled();

    layer.visible = true;
    pipeline.updateTiles([layer], getViewport);
    expect(getViewport).toHaveBeenCalledOnce();
    expect(planTiles).toHaveBeenCalledOnce();
  });

  test("rebinds a grown tile index buffer before drawing", () => {
    const replacementIndexBuffer = {};
    const replacementBindGroup = {};
    const createBindGroup = vi.fn(() => replacementBindGroup);
    const rendererPipeline = { getBindGroupLayout: vi.fn(() => ({})) };
    const planTiles = vi.fn(() => ({
      plan: { level: 0 },
      loader: {},
    }));
    const layer = {
      id: "volume",
      visible: true,
      isReady: true,
      planTiles,
      getLevelResolution: () => 1,
    } as unknown as BaseLayer;
    const pool = {
      capacity: 8,
      indexBuffer: replacementIndexBuffer,
      readyBuffer: {},
      regionBuffer: {},
    };
    const tileManager = {
      pool,
      hasVisibleTile: () => false,
      commit: vi.fn(() => ({
        complete: false,
        indexBufferChanged: true,
      })),
    };
    const state = {
      layer,
      pipeline: rendererPipeline,
      tileManager,
      tileBindGroup: {},
      tilesActive: false,
      showingInitialTiles: false,
      lastDataVersion: 0,
    };
    const pipeline = new ViewPipeline({
      label: "test",
      device: { createBindGroup },
    } as unknown as ConstructorParameters<typeof ViewPipeline>[0]);
    (pipeline as any).states.set(layer.id, state);

    pipeline.updateTiles([layer], () => ({
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      worldUnitsPerPixel: 1,
    }));

    expect(state.tileBindGroup).toBe(replacementBindGroup);
    expect(createBindGroup).toHaveBeenCalledWith(expect.objectContaining({
      entries: expect.arrayContaining([
        { binding: 0, resource: { buffer: replacementIndexBuffer } },
      ]),
    }));
  });
});