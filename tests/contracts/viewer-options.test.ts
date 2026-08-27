/**
 * High-level tool config purity tests.
 *
 * The Viewer config surface is JSON-serializable intent: tool option bags
 * carry no functions and no DOM objects. This file pins the contract:
 *
 * - Compile-time (`bun run typecheck`): `@ts-expect-error` probes reject
 *   callbacks in `ViewerConfig` and in `viewer.tool("roi").configure`.
 * - Runtime: a function smuggled past the types throws an actionable error
 *   naming the tool/key and the supported event path — it is never silently
 *   dropped by the `viewer.getState()` JSON mirror.
 * - Every high-level tool's options round-trip through JSON unchanged.
 *
 * Harness mirrors tests/integration/viewer/harness.ts: a stub Dataset kind +
 * fake canvas + fake WebGPU device (rAF stubbed — no render pass runs).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  registerDatasetAdapter,
  type DatasetConfig,
  type Viewer,
  type ViewerConfig,
  type ViewerToolsConfig,
} from "../../src/index";
import { datasetRegistry } from "../../src/registry";
import type { ImagePyramid } from "../../src/state/schema";

// ============================================================================
// COMPILE-TIME PROBES (checked by the typecheck gate)
// ============================================================================

// The serializable ROI tool options compile — boxes, active index, flags.
const roiTools: ViewerConfig = {
  tools: {
    roi: {
      visible      : true,
      enabled      : true,
      rois         : [{ min: [0, 0, 0], max: [10, 20, 30] }],
      activeIndex  : 0,
    },
  },
};

// @ts-expect-error — callbacks are not part of the high-level tool config
const badRoiConfig: ViewerConfig = { tools: { roi: { onRoisChange: () => {} } } };

// @ts-expect-error — ditto for onActiveIndexChange
const badActiveConfig: ViewerConfig = { tools: { roi: { onActiveIndexChange: () => {} } } };

// @ts-expect-error — per-composition override tool bags are equally JSON-only
const badOverride: ViewerConfig = { compositions: { slice: { tools: { roi: { onRoisChange: () => {} } } } } };

function configureProbes(viewer: Viewer): void {
  viewer.tool("roi").configure({ visible: true, enabled: true }); // serializable — OK
  // @ts-expect-error — configure rejects callback keys at compile time
  viewer.tool("roi").configure({ onRoisChange: () => {} });
  // @ts-expect-error — configure rejects callback keys at compile time
  viewer.tool("roi").configure({ onActiveIndexChange: () => {} });
}
void configureProbes; // compile-time probe only — never invoked

// ============================================================================
// STUB DATASET KIND
// ============================================================================

const KIND = "tools-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "tools-stub": { type: "tools-stub"; source: string };
  }
}

const PYRAMID_3D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [1, 1, 1] }],
};

const DESC_3D: DatasetConfig = { type: KIND, source: "mem://3d" };

class StubPyramidDataset extends Dataset {
  pyramid: ImagePyramid = PYRAMID_3D;
  fetch = async () => new ArrayBuffer(0);

  override async load(): Promise<void> {
    this.physical = { spatial: { size: [8, 8, 4], unit: "µm", spacing: [1, 1, 1], origin: [0, 0, 0] } };
    this.dimensions = [{ name: "c", size: 1, labels: ["a"] }];
    this.defaultSelection = { c: 0 };
    this.channels = [{ index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true }];
    this.resources = [{
      id: "image",
      kind: "image-pyramid",
      pyramid: this.pyramid,
      fetch: this.fetch,
      physical: this.physical,
      dimensions: this.dimensions,
      defaultSelection: this.defaultSelection,
      channels: this.channels,
    }];
    this.primaryResourceId = "image";
  }

  override dispose(): void {}
}

// ============================================================================
// FAKE DOM + WEBGPU
// ============================================================================

function makeFakeCanvas(): HTMLCanvasElement {
  const el: Record<string, unknown> = {
    tagName       : "CANVAS",
    style         : {},
    clientWidth   : 256,
    clientHeight  : 256,
    width         : 0,
    height        : 0,
    parentElement : null,
    parentNode    : null,
    getContext    : () => ({ configure() {}, unconfigure() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
    setAttribute() {},
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
  };
  return el as unknown as HTMLCanvasElement;
}

function stubWebGPU(): void {
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {}, width: 1, height: 1 }),
    destroy() {},
    queue: {
      writeBuffer() {},
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, STORAGE: 0x80 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x01, COPY_DST: 0x08 });
  vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

// ============================================================================
// HARNESS
// ============================================================================

let viewers: Viewer[];

beforeEach(() => {
  viewers = [];
  stubWebGPU();
  registerDatasetAdapter(KIND, (config) => new StubPyramidDataset(config));
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  vi.unstubAllGlobals();
});

async function makeViewer(config: ViewerConfig = {}): Promise<Viewer> {
  const viewer = await createViewer(makeFakeCanvas(), config);
  viewers.push(viewer);
  return viewer;
}

// ============================================================================
// RUNTIME REJECTION
// ============================================================================

describe("high-level tool config rejects functions", () => {
  test("createViewer config: a callback in tools.roi throws an actionable error", async () => {
    await expect(makeViewer({
      tools: { roi: { onRoisChange: () => {} } as never },
    })).rejects.toThrow(/config: tools\.roi\.onRoisChange is a function/);
    await expect(makeViewer({
      tools: { roi: { onActiveIndexChange: () => {} } as never },
    })).rejects.toThrow(/viewer\.on\("roiChange" \| "roiActiveChange", handler\)/);
  });

  test("createViewer config: functions in ANY tool bag throw (not only roi)", async () => {
    await expect(makeViewer({
      tools: { ruler: { onChange: () => {} } as never },
    })).rejects.toThrow(/tools\.ruler\.onChange is a function/);
    await expect(makeViewer({
      tools: { magnifier: { onZoom: () => {} } as never },
    })).rejects.toThrow(/tools\.magnifier\.onZoom is a function/);
  });

  test("per-composition overrides reject functions in tool bags", async () => {
    await expect(makeViewer({
      dataset: DESC_3D,
      compositions: { slice: { tools: { roi: { onRoisChange: () => {} } as never } } },
    })).rejects.toThrow(/compositions\.slice: tools\.roi\.onRoisChange is a function/);
  });

  test("viewer.tool().configure rejects functions at runtime", async () => {
    const viewer = await makeViewer({ dataset: DESC_3D });
    expect(() => viewer.tool("roi").configure({ onRoisChange: () => {} } as never))
      .toThrow(/viewer\.tool\("roi"\)\.configure: tools\.roi\.onRoisChange is a function/);
    expect(() => viewer.tool("crosshair").configure({ onMove: () => {} } as never))
      .toThrow(/tools\.crosshair\.onMove is a function/);
  });

  test("viewer.composition().configure rejects functions in tool bags", async () => {
    const viewer = await makeViewer({ dataset: DESC_3D });
    expect(() => viewer.composition("slice").configure({
      tools: { roi: { onActiveIndexChange: () => {} } as never },
    })).toThrow(/viewer\.composition\("slice"\)\.slice: tools\.roi\.onActiveIndexChange is a function/);
  });
});

// ============================================================================
// JSON PURITY
// ============================================================================

describe("high-level tool config stays pure JSON", () => {
  test("every high-level tool's options are pure JSON; only tool VALUES enter the state", async () => {
    const tools: ViewerToolsConfig = {
      crosshair : { position: [1, 2, 3], lineWidth: 2, visible: true },
      ruler     : { unit: "µm", lineWidth: 2, resetNonce: 3, visibleWhenActive: true },
      magnifier : { dimension: "2d", zoom: 6, size: 200, voxelExtent3d: 16 },
      roi       : { visible: true, enabled: true, rois: [{ min: [0, 0, 0], max: [10, 20, 30] }], activeIndex: 0 },
    };
    expect(JSON.parse(JSON.stringify(tools))).toEqual(tools);

    const viewer = await makeViewer({ dataset: DESC_3D, tools });
    const emitted = viewer.getState();
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(emitted);
    // Tool OPTIONS (enabled flags, sizes, …) are viewer-local presentation
    // preferences — they stay in ViewerConfig. `State.tools` carries tool
    // VALUES only: the ROI selections and active index.
    expect(emitted.tools).toEqual({
      roi: { rois: [{ min: [0, 0, 0], max: [10, 20, 30] }], activeIndex: 0 },
    });
  });

  test("the compile fixtures stay reference-frozen", () => {
    // The valid fixture is pure JSON; the @ts-expect-error ones exist for the
    // typecheck gate — keep them referenced so unused-local checks stay quiet.
    expect(JSON.parse(JSON.stringify(roiTools))).toEqual(roiTools);
    void badRoiConfig;
    void badActiveConfig;
    void badOverride;
  });
});
