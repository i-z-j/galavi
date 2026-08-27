/**
 * Viewer channel/projection integration tests (declarative/imperative parity
 * §15.4): the channel model maps dataset-driven
 * intent onto generated layers and the volume projection setting follows the
 * same path — headless via the shared integration/viewer harness (stub
 * dataset kind + fake WebGPU/canvas).
 */
import { describe, expect, test } from "vitest";
import {
  DESC_3D,
  compositionOverridesOf,
  layerOf,
  makeFakeCanvas,
  makeViewer,
  setupViewerHarness,
} from "./harness";

setupViewerHarness();

// ============================================================================
// CHANNELS + DECLARATIVE/IMPERATIVE PARITY (§15.4)
// ============================================================================

describe("channel model", () => {
  test("config channels and channel().configure produce identical layers", async () => {
    const patch = { visible: true, color: "ff0000", contrast: [0.2, 0.8] as [number, number] };
    const declarative = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      channels: [{ index: 1, ...patch }],
    });
    const imperative = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    imperative.channel(1).configure(patch);

    const a = layerOf(declarative, "volume-c1");
    const b = layerOf(imperative, "volume-c1");
    expect(b.render).toEqual(a.render);
    expect(b.options).toEqual(a.options);
    // Shared normalization: the color normalized to #RRGGBB on both paths.
    expect(a.render?.color).toBe("#FF0000");
    expect(a.render?.contrastLimits).toEqual([0.2, 0.8]);
  });

  test("channel().configure maps to every internal layer for that channel", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.channel(1).configure({ visible: true, contrast: [0.1, 0.4] });
    expect(layerOf(viewer, "volume-c1").render).toMatchObject({ visible: true, contrastLimits: [0.1, 0.4] });

    // Channel intent survives the mode transition onto the new slice layers.
    await viewer.setComposition({ type: "slice" });
    expect(layerOf(viewer, "slice-c1").render).toMatchObject({ visible: true, contrastLimits: [0.1, 0.4] });
    expect(layerOf(viewer, "slice-c0").render).toMatchObject({ visible: true, contrastLimits: [0, 1] });
  });

  test("channel().config and viewer.channels expose the effective state", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.channel(0).configure({ label: "DAPI" });
    expect(viewer.channel(0).config).toEqual({
      index: 0, label: "DAPI", visible: true, color: "#00B0FF", contrast: [0, 1],
    });
    expect(viewer.channels.map((c) => c.label)).toEqual(["DAPI", "b"]);
    // Labels reach the shared physical channel names.
    expect(viewer.runtime!.getState().physical?.channels?.names).toEqual(["DAPI", "b"]);
  });

  test("channel().configure wins over the active mode override (edit what you see)", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), {
      dataset: DESC_3D,
      composition: { type: "slice" },
      compositions: { slice: { channels: [{ index: 0, contrast: [0, 0.05] }] } },
    });
    expect(viewer.channel(0).config.contrast).toEqual([0, 0.05]);
    viewer.channel(0).configure({ contrast: [0.1, 0.2] });
    // The live edit is not masked by the mode override…
    expect(viewer.channel(0).config.contrast).toEqual([0.1, 0.2]);
    expect(layerOf(viewer, "slice-c0").render).toMatchObject({ contrastLimits: [0.1, 0.2] });
    // …and viewer.getState() mirrors it in the active mode's override.
    expect(compositionOverridesOf(viewer)?.slice?.channels?.[0]?.contrast).toEqual([0.1, 0.2]);
  });

  test("channel index validation is actionable", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    expect(() => viewer.channel(2)).toThrow(/index out of range.*2 channel/);
    expect(() => viewer.channel(0).configure({ color: "red" })).toThrow(/invalid color "red"/);
    const idle = await makeViewer();
    expect(() => idle.channel(0)).toThrow(/no dataset open/);
  });
});

// ============================================================================
// PROJECTION
// ============================================================================

describe("projection", () => {
  test("config projection maps to volume layer render.volumeProjection", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D, projection: "minip" });
    expect(layerOf(viewer, "volume-c0").render?.volumeProjection).toBe("minip");
    expect(layerOf(viewer, "volume-c1").render?.volumeProjection).toBe("minip");
  });

  test("imperative projection updates live volume layers and survives rebuilds", async () => {
    const viewer = await makeViewer(makeFakeCanvas(), { dataset: DESC_3D });
    viewer.projection = "mean";
    expect(layerOf(viewer, "volume-c0").render?.volumeProjection).toBe("mean");
    await viewer.setComposition({ type: "slice" });
    expect(layerOf(viewer, "slice-c0").render?.volumeProjection).toBeUndefined();
    await viewer.setComposition({ type: "volume" });
    expect(layerOf(viewer, "volume-c0").render?.volumeProjection).toBe("mean");
    expect(() => { viewer.projection = "bogus" as never; }).toThrow(/Invalid projection/);
  });
});
