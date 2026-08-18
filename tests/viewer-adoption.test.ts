/**
 * Viewer Dataset-adoption ownership tests (API-5).
 *
 * `viewer.open(dataset)` adopts an already-loaded Dataset: ownership
 * transfers AT INVOCATION, so after the call only the Viewer disposes it —
 * on supersession, replacement by a newer open, rebuild failure, and viewer
 * destroy (even when the returned promise rejects). A config open keeps
 * loading through the registry; `openDataset(config)` instances stay
 * caller-owned until adopted.
 *
 * The metadata-open counting tests run the REAL "ome-zarr" kind against a
 * stubbed global fetch: one metadata open per normal
 * `createViewer({ dataset: config })`, one per explicit
 * `openOMEZarrDataset` pre-open, and ZERO additional requests when the
 * pre-opened Dataset is adopted.
 *
 * Headless: fake WebGPU device + fake DOM (rAF stubbed — no render pass
 * runs). Ownership is asserted with per-instance dispose spies.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  openDataset,
  registerDataset,
  ViewerSupersededError,
  type DatasetConfig,
  type DefaultLayersOptions,
  type Viewer,
} from "../src/index";
import { ImageDataset, openOMEZarrDataset } from "../src/dataset/ome-zarr";
import { datasetRegistry } from "../src/registry";
import type { ImagePyramid, LayerConfig } from "../src/types";

// ============================================================================
// SPY DATASET KIND — per-instance dispose spies
// ============================================================================

const KIND = "adoption-spy";

declare module "galavi" {
  interface DatasetConfigMap {
    "adoption-spy": { type: "adoption-spy"; source: string };
  }
}

const CONFIG: DatasetConfig = { type: KIND, source: "mem://spy" };

const PYRAMID: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [1, 1, 2] }],
};

class SpyDataset extends Dataset {
  readonly disposeSpy = vi.fn();
  /** When set, layer generation fails — drives a rebuild failure after adoption. */
  failLayers = false;

  override async load(): Promise<void> {
    this.physical = { spatial: { size: [4, 4, 8], spacing: [1, 1, 2], origin: [0, 0, 0] } };
    this.channels = [{ index: 0, label: "a", color: "#00B0FF", contrast: [0, 1], visible: true }];
    this.capabilities = { modes: ["slice", "volume", "quad"], defaultMode: "volume" };
  }

  override dispose(): void {
    this.disposeSpy();
  }

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    if (this.failLayers) throw new Error("cannot build layers");
    return [{
      id      : `${options.prefix}-c0`,
      type    : options.view,
      data    : { pyramid: PYRAMID, fetch: async () => new ArrayBuffer(0) },
      options : { selection: { c: 0 } },
    }];
  }
}

/** Registry-made instances, for asserting which instance a config open produced. */
let created: SpyDataset[];

/** Construct + load a caller-owned spy dataset directly (the pre-open path). */
async function loadedSpy(): Promise<SpyDataset> {
  const dataset = new SpyDataset(CONFIG);
  await dataset.load();
  return dataset;
}

// ============================================================================
// FAKE DOM + WEBGPU
// ============================================================================

type FakeElement = {
  tagName: string;
  style: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  parentNode: FakeElement | null;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  setAttribute(): void;
  hasAttribute(): boolean;
  addEventListener(): void;
  removeEventListener(): void;
  ownerDocument?: unknown;
} & Record<string, unknown>;

function makeFakeElement(tag = "div"): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    parentElement: null,
    parentNode: null,
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentElement = null;
      child.parentNode = null;
      return child;
    },
    setAttribute() {},
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function makeFakeCanvas(): HTMLCanvasElement {
  const el = makeFakeElement("canvas");
  el.clientWidth = 256;
  el.clientHeight = 256;
  el.width = 0;
  el.height = 0;
  el.getContext = () => ({ configure() {}, unconfigure() {} });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256 });
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
  created = [];
  stubWebGPU();
  registerDataset(KIND, (config) => {
    const dataset = new SpyDataset(config);
    created.push(dataset);
    return dataset;
  });
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  datasetRegistry.unregister(KIND);
  vi.unstubAllGlobals();
});

function track(viewer: Viewer): Viewer {
  viewers.push(viewer);
  return viewer;
}

// ============================================================================
// OWNERSHIP
// ============================================================================

describe("Viewer dataset adoption (API-5)", () => {
  test("openDataset instances stay caller-owned until adopted", async () => {
    const dataset = (await openDataset(CONFIG)) as SpyDataset;
    expect(dataset).toBeInstanceOf(SpyDataset);
    expect(dataset.disposeSpy).not.toHaveBeenCalled();

    dataset.dispose(); // never adopted — the caller disposes its own
    expect(dataset.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("successful adoption: the viewer owns the exact instance until destroy", async () => {
    const viewer = track(await createViewer(makeFakeCanvas()));
    const dataset = await loadedSpy();

    await viewer.open(dataset);

    expect(viewer.dataset).toBe(dataset); // the adopted instance — no reopen
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedMode).toBe("volume");
    expect(viewer.engine!.getState().layers.map((l) => l.id)).toEqual(["volume-c0"]);
    // viewer.config stays pure JSON: the adopted dataset's declarative config.
    expect(viewer.config.dataset).toEqual(CONFIG);
    expect(dataset.disposeSpy).not.toHaveBeenCalled();

    viewer.destroy();
    expect(dataset.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("ownership transfers at invocation: replacement disposes synchronously", async () => {
    const viewer = track(await createViewer(makeFakeCanvas()));
    const first = await loadedSpy();
    await viewer.open(first);

    const second = await loadedSpy();
    const pending = viewer.open(second);
    // The second adoption replaced the first AT INVOCATION — before any await.
    expect(first.disposeSpy).toHaveBeenCalledTimes(1);
    expect(second.disposeSpy).not.toHaveBeenCalled();

    await pending;
    expect(viewer.dataset).toBe(second);
    expect(viewer.status).toBe("ready");
  });

  test("a config open after adoption disposes the adopted dataset", async () => {
    const viewer = track(await createViewer(makeFakeCanvas()));
    const adopted = await loadedSpy();
    await viewer.open(adopted);

    await viewer.open(CONFIG); // registry path — a fresh, viewer-loaded instance
    expect(adopted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(viewer.dataset).toBe(created[created.length - 1]);
    expect(viewer.dataset).not.toBe(adopted);
  });

  test("failed rebuild after adoption: the viewer disposes the adopted dataset", async () => {
    const viewer = track(await createViewer(makeFakeCanvas()));
    const dataset = await loadedSpy();
    dataset.failLayers = true;

    // The promise rejects — and the CALLER still must not dispose: the
    // viewer did, when the rebuild failed.
    await expect(viewer.open(dataset)).rejects.toThrow("cannot build layers");
    expect(viewer.status).toBe("error");
    expect(viewer.dataset).toBeUndefined();
    expect(dataset.disposeSpy).toHaveBeenCalledTimes(1);

    viewer.destroy();
    expect(dataset.disposeSpy).toHaveBeenCalledTimes(1); // never disposed twice
  });

  test("superseded adoption: the newer open disposes the superseded dataset", async () => {
    const viewer = track(await createViewer(makeFakeCanvas()));
    const stale = await loadedSpy();
    const fresh = await loadedSpy();

    const staleOpen = viewer.open(stale);
    const freshOpen = viewer.open(fresh); // wins; disposes stale at invocation
    expect(stale.disposeSpy).toHaveBeenCalledTimes(1);

    await expect(staleOpen).rejects.toBeInstanceOf(ViewerSupersededError);
    await freshOpen;
    expect(viewer.dataset).toBe(fresh);
    expect(fresh.disposeSpy).not.toHaveBeenCalled();

    viewer.destroy();
    expect(fresh.disposeSpy).toHaveBeenCalledTimes(1);
    expect(stale.disposeSpy).toHaveBeenCalledTimes(1); // exactly once overall
  });

  test("adopting the live dataset again rebuilds without disposing it", async () => {
    const viewer = track(await createViewer(makeFakeCanvas()));
    const dataset = await loadedSpy();
    await viewer.open(dataset);

    await viewer.open(dataset); // same instance — a re-entry, not a replacement
    expect(viewer.dataset).toBe(dataset);
    expect(dataset.disposeSpy).not.toHaveBeenCalled();
    expect(viewer.status).toBe("ready");
  });
});

// ============================================================================
// METADATA-OPEN COUNTING — real "ome-zarr" kind, stub fetch
// ============================================================================

const ZARR_URL = "https://example.test/adopt-me.ome.zarr";

// Minimal v3 2D store: shape [y=8, x=8], chunks [4, 4], one pyramid level.
const GROUP_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: {
    ome: {
      version: "0.5",
      multiscales: [{
        axes: [
          { name: "y", type: "space" },
          { name: "x", type: "space" },
        ],
        datasets: [{
          path: "0",
          coordinateTransformations: [{ type: "scale", scale: [0.5, 0.5] }],
        }],
      }],
    },
  },
});

const ARRAY_JSON = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [8, 8],
  data_type: "uint16",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: 0,
  codecs: [{ name: "bytes", configuration: {} }],
  attributes: {},
  dimension_names: ["y", "x"],
});

describe("metadata-open counting (API-5)", () => {
  const encoder = new TextEncoder();
  let requests: string[];
  /** Root `zarr.json` GETs — one per store metadata open. */
  let metadataOpens: number;

  beforeEach(() => {
    requests = [];
    metadataOpens = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const href = String(input);
      requests.push(href);
      if (href === `${ZARR_URL}/zarr.json`) {
        metadataOpens++;
        return new Response(encoder.encode(GROUP_JSON), { status: 200 });
      }
      if (href === `${ZARR_URL}/0/zarr.json`) {
        return new Response(encoder.encode(ARRAY_JSON), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
  });

  test("one metadata open per normal createViewer({ dataset: config })", async () => {
    const viewer = track(await createViewer(makeFakeCanvas(), {
      dataset: { type: "ome-zarr", source: ZARR_URL },
    }));

    expect(viewer.status).toBe("ready");
    expect(viewer.dataset).toBeInstanceOf(ImageDataset);
    expect(metadataOpens).toBe(1);
    // The one open fetched exactly the root + single-level array metadata.
    expect(requests).toEqual([`${ZARR_URL}/zarr.json`, `${ZARR_URL}/0/zarr.json`]);
  });

  test("one metadata open per explicit pre-open; adoption adds ZERO opens", async () => {
    const dataset = await openOMEZarrDataset(ZARR_URL);
    expect(metadataOpens).toBe(1); // the explicit pre-open
    expect(dataset.info?.omeVersion).toBe("0.5");
    const requestsAfterPreOpen = requests.length;

    const viewer = track(await createViewer(makeFakeCanvas()));
    await viewer.open(dataset); // adoption — no store traffic at all

    expect(viewer.dataset).toBe(dataset);
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedMode).toBe("slice"); // 2D store
    expect(metadataOpens).toBe(1);
    expect(requests.length).toBe(requestsAfterPreOpen);
  });
});
