/**
 * Typed overlay options (DX-Q4).
 *
 * Type-level: `ViewAccessor.setOverlayOptions` and `ViewConfig.overlays` give
 * built-in overlay types their exact options bag (a misspelled key is a
 * compile error) while custom/plugin overlay types keep the
 * `Record<string, unknown>` escape hatch. Runtime: custom overlay types still
 * receive their options verbatim through the same path.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createViewerEngine, type ViewerEngine } from "../src/viewer";
import { registerOverlay } from "../src/registry";
import { BaseOverlay } from "../src/overlay";
import type { State, ViewConfig } from "../src/types";

/** Minimal custom overlay recording the last options it received. */
class RecorderOverlay extends BaseOverlay {
  received?: Record<string, unknown>;
  override setOptions(opts?: Record<string, unknown>): void {
    this.received = opts;
    super.setOptions(opts);
  }
  protected onRender(_state: State): void {}
}

registerOverlay("test-recorder", () => new RecorderOverlay());

const initialState: State = {
  layers      : [],
  exploration : {
    camera: {
      navMode  : "orbit",
      projMode : "perspective",
      position : [1.13, 0.12, 1.13],
      target   : [0.5, 0.5, 0.5],
    },
  },
};

describe("setOverlayOptions typing (compile-time)", () => {
  let engine: ViewerEngine | undefined;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    engine?.destroy();
    engine = undefined;
    vi.unstubAllGlobals();
  });

  test("built-in keys are typed; custom types keep the escape hatch", async () => {
    engine = await createViewerEngine({
      state : initialState,
      views : { main: { type: "volume", layers: [] } },
    });
    const view = engine.view("main");

    // Built-in overlay: exact options bag.
    view.setOverlayOptions("crosshair", { visible: true, position: [0, 0, 0], lineWidth: 2 });
    view.setOverlayOptions("ruler", { visible: true, unit: "µm", resetNonce: 1 });
    view.setOverlayOptions("roiselector", { enabled: false, activeIndex: null });
    view.setOverlayOptions("magnifier-3d", { position: null, voxelExtent3d: 32 });

    // @ts-expect-error misspelled key on a built-in overlay is a compile error
    view.setOverlayOptions("crosshair", { visibile: true });

    // @ts-expect-error wrong value type on a built-in overlay is a compile error
    view.setOverlayOptions("ruler", { lineWidth: "thick" });

    // Custom/plugin overlay types: untyped escape hatch.
    view.setOverlayOptions("my-plugin-overlay", { visibile: true, anything: 1 });

    // Dynamic (non-literal) type strings also fall back to the escape hatch.
    const dynamicType: string = "crosshair";
    view.setOverlayOptions(dynamicType, { visibile: true });
  });

  test("ViewConfig.overlays types built-in keys, allows custom types", () => {
    const good: ViewConfig = {
      type     : "slice",
      layers   : [],
      overlays : {
        crosshair           : { visible: false },
        ruler               : { visible: false, unit: "µm" },
        "magnifier-3d"      : { visible: false, voxelExtent3d: 32, layers: ["volume"] },
        "my-plugin-overlay" : { anyKey: 1 },
      },
    };
    expect(good.overlays).toBeDefined();

    // @ts-expect-error misspelled key on a built-in overlay is a compile error
    const bad: ViewConfig = { type: "slice", layers: [], overlays: { crosshair: { visibile: false } } };
    void bad;
  });
});

describe("setOverlayOptions runtime pass-through", () => {
  let engine: ViewerEngine | undefined;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    engine?.destroy();
    engine = undefined;
    vi.unstubAllGlobals();
  });

  test("custom overlay types receive their options verbatim", async () => {
    engine = await createViewerEngine({
      state : initialState,
      views : {
        main: {
          type     : "volume",
          layers   : [],
          overlays : { "test-recorder": { initial: true } },
        },
      },
    });
    const overlay = engine.view("main").base.getOverlays()[0] as RecorderOverlay;
    expect(overlay.received).toEqual({ initial: true });

    engine.view("main").setOverlayOptions("test-recorder", { custom: 42 });
    expect(overlay.received).toEqual({ custom: 42 });
  });
});
