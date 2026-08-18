/**
 * High-level Viewer layer-readiness tests (ARCH-1, DX-M2).
 *
 * `createViewer` / `viewer.open` / mode transitions resolve `viewer.ready`
 * only once every unique generated layer reports structural readiness —
 * tiled layers count as ready when their source/pyramid is available (NOT
 * full tile refinement), source-backed layers (surfaces) once fetched and
 * parsed. A failed source rejects `createViewer`/`viewer.ready`, flips
 * `viewer.status` to `"error"`, and recovers on a later open.
 *
 * A stub dataset kind emits one URL-backed surface layer per view so the
 * global fetch stub controls each layer's settle. Headless: fake WebGPU
 * device + fake DOM (rAF stubbed — no render pass runs).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  MeshDataset,
  registerDataset,
  type DatasetConfig,
  type DefaultLayersOptions,
  type Viewer,
} from "../src/advanced";
import { SurfaceLayer } from "../src/layer";
import { datasetRegistry } from "../src/registry";
import type { LayerConfig } from "../src/types";

// ============================================================================
// STUB DATASET KIND — one URL-backed surface layer per generated view
// ============================================================================

const KIND = "readiness-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "readiness-stub": { type: "readiness-stub"; source: string };
  }
}

const DESC: DatasetConfig = { type: KIND, source: "mem://scene" };

class StubSurfaceDataset extends Dataset {
  override async load(): Promise<void> {
    this.physical = { spatial: { size: [10, 10, 10], spacing: [1, 1, 1], origin: [0, 0, 0] } };
    this.channels = [{ index: 0, label: "s", color: "#FFFFFF", contrast: [0, 1], visible: true }];
    this.capabilities = { modes: ["slice", "volume", "quad"], defaultMode: "volume" };
  }

  override dispose(): void {}

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    return [{
      id   : `${options.prefix}-surf`,
      type : "surface",
      data : { url: `mem://surf-${options.prefix}.obj` },
    }];
  }
}

// ============================================================================
// FAKE DOM + WEBGPU
// ============================================================================

const OBJ = [
  "v 0 0 0",
  "v 1 0 0",
  "v 0 1 0",
  "f 1 2 3",
  "",
].join("\n");

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

function makeFakeContainer(): HTMLElement {
  const el = makeFakeElement("div");
  el.ownerDocument = {
    createElement: (tag: string) =>
      tag === "canvas" ? (makeFakeCanvas() as unknown as FakeElement) : makeFakeElement(tag),
  };
  return el as unknown as HTMLElement;
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
// FETCH GATES — per-URL deferred control over layer loads
// ============================================================================

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> };

interface Gate {
  promise : Promise<FakeResponse>;
  resolve : (value: FakeResponse) => void;
  reject  : (err: unknown) => void;
}

function makeGate(): Gate {
  let resolve!: (value: FakeResponse) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<FakeResponse>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function okResponse(body = OBJ): FakeResponse {
  return { ok: true, status: 200, text: async () => body };
}

async function flushMicrotasks(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ============================================================================
// HARNESS
// ============================================================================

let viewers: Viewer[];
let fetchSpy: ReturnType<typeof vi.fn>;
/** Per-URL gates; gated URLs resolve when the test resolves the gate. */
let gates: Map<string, Gate>;
/** Per-URL failure statuses. */
let failing: Map<string, number>;
/** Per-URL success bodies; URLs with no entry fall back to the default OBJ. */
let bodies: Map<string, string>;

beforeEach(() => {
  viewers = [];
  gates = new Map();
  failing = new Map();
  bodies = new Map();
  stubWebGPU();
  fetchSpy = vi.fn((input: unknown) => {
    const url = String(input);
    const status = failing.get(url);
    if (status !== undefined) {
      return Promise.resolve({ ok: false, status, text: async () => "" });
    }
    const gate = gates.get(url);
    if (gate) return gate.promise;
    return Promise.resolve(okResponse(bodies.get(url) ?? OBJ));
  });
  vi.stubGlobal("fetch", fetchSpy);
  registerDataset(KIND, (config) => new StubSurfaceDataset(config));
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
// READY SEMANTICS
// ============================================================================

describe("Viewer awaits generated layer readiness (ARCH-1)", () => {
  test("createViewer resolves only after the surface layer loads", async () => {
    gates.set("mem://surf-volume.obj", makeGate());
    let settled = false;
    const pending = createViewer(makeFakeCanvas(), { dataset: DESC }).then((viewer) => {
      settled = true;
      return track(viewer);
    });

    await flushMicrotasks();
    expect(settled).toBe(false); // gated on the layer's fetch, not just the dataset

    gates.get("mem://surf-volume.obj")!.resolve(okResponse());
    const viewer = await pending;
    expect(settled).toBe(true);
    expect(viewer.status).toBe("ready");
    expect(viewer.engine!.view("main").getLayerStatus("volume-surf")).toEqual({ status: "ready" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // one fetch for the one layer
  });

  test("a failing surface rejects open and viewer.ready; status records the error", async () => {
    failing.set("mem://surf-volume.obj", 404);
    const viewer = track(await createViewer(makeFakeCanvas()));
    await expect(viewer.open(DESC)).rejects.toThrow("Surface fetch failed: 404");
    expect(viewer.status).toBe("error");
    expect((viewer.error as Error).message).toBe("Surface fetch failed: 404");
    await expect(viewer.ready).rejects.toThrow("Surface fetch failed: 404");

    // Recovery: a later open with the source fixed becomes ready.
    failing.delete("mem://surf-volume.obj");
    await viewer.open(DESC);
    expect(viewer.status).toBe("ready");
    expect(viewer.error).toBeUndefined();
  });

  test("createViewer rejects when a generated layer fails", async () => {
    failing.set("mem://surf-volume.obj", 500);
    await expect(createViewer(makeFakeCanvas(), { dataset: DESC })).rejects.toThrow(
      "Surface fetch failed: 500",
    );
  });

  test("quad mode awaits every unique layer across its four views", async () => {
    const urls = ["quad-xy", "quad-xz", "quad-yz", "quad-3d"].map((p) => `mem://surf-${p}.obj`);
    for (const url of urls) gates.set(url, makeGate());

    let settled = false;
    const pending = createViewer(makeFakeContainer(), { dataset: DESC, mode: "quad" }).then((viewer) => {
      settled = true;
      return track(viewer);
    });
    await flushMicrotasks();

    // One fetch per unique generated layer — all four were requested.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(settled).toBe(false);

    // Resolving three of four layers still gates readiness on the last one.
    for (const url of urls.slice(0, 3)) gates.get(url)!.resolve(okResponse());
    await flushMicrotasks();
    expect(settled).toBe(false);

    gates.get(urls[3]!)!.resolve(okResponse());
    const viewer = await pending;
    expect(settled).toBe(true);
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedMode).toBe("quad");
    for (const prefix of ["quad-xy", "quad-xz", "quad-yz", "quad-3d"]) {
      expect(viewer.engine!.view(prefix).getLayerStatus(`${prefix}-surf`)).toEqual({ status: "ready" });
    }
  });

  test("a quad layer failure rejects viewer.ready through a non-active view", async () => {
    // quad-yz is not the active view — the old snapshot check never saw it.
    const viewer = track(await createViewer(makeFakeContainer(), { dataset: DESC }));
    expect(viewer.resolvedMode).toBe("volume");
    failing.set("mem://surf-quad-yz.obj", 404);
    viewer.mode = "quad";
    await expect(viewer.ready).rejects.toThrow("Surface fetch failed: 404");
    expect(viewer.status).toBe("error");
  });

  test("mode transitions re-await the new mode's generated layers", async () => {
    const viewer = track(await createViewer(makeFakeContainer(), { dataset: DESC }));
    expect(viewer.status).toBe("ready"); // volume-surf loaded (no gate)

    gates.set("mem://surf-quad-xy.obj", makeGate());
    let settled = false;
    viewer.mode = "quad";
    const transition = viewer.ready.then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false); // gated on quad-xy's layer

    gates.get("mem://surf-quad-xy.obj")!.resolve(okResponse());
    await transition;
    expect(settled).toBe(true);
    expect(viewer.resolvedMode).toBe("quad");
  });
});

// ============================================================================
// MESH — ONE FETCH, ONE PARSE, READY AFTER ADOPTION
// ============================================================================

describe("MeshDataset viewer readiness (ARCH-1)", () => {
  const MESH_OBJ = [
    "# tetrahedron",
    "v 0 0 0",
    "v 10 0 0",
    "v 0 20 0",
    "v 0 0 30",
    "f 1 2 3",
    "f 1 2 4",
    "f 1 3 4",
    "f 2 3 4",
    "",
  ].join("\n");

  test("exactly one network fetch total; the surface layer adopts the parsed geometry", async () => {
    bodies.set("mem://mesh.obj", MESH_OBJ);
    const viewer = track(await createViewer(makeFakeCanvas(), {
      dataset: { type: "mesh", source: "mem://mesh.obj" },
    }));
    expect(viewer.dataset).toBeInstanceOf(MeshDataset);
    expect(viewer.status).toBe("ready");

    // The dataset's load() fetched once; the layer consumed Data.geometry —
    // it never fetched the URL itself.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("mem://mesh.obj");

    const layer = viewer.engine!.view("main").getLayer("volume-mesh");
    expect(layer).toBeInstanceOf(SurfaceLayer);
    expect(viewer.engine!.view("main").getLayerStatus("volume-mesh")).toEqual({ status: "ready" });
    // The adopted geometry is parsed and fitted (4 triangles → 12 vertices).
    expect((layer as SurfaceLayer).getPositions()).toBeInstanceOf(Float32Array);
    expect((layer as SurfaceLayer).getPositions()!.length).toBe(12 * 3);
  });

  test("the surface layer keeps working when the same engine rebuilds from the dataset", async () => {
    bodies.set("mem://mesh.obj", MESH_OBJ);
    const viewer = track(await createViewer(makeFakeCanvas(), {
      dataset: { type: "mesh", source: "mem://mesh.obj" },
    }));
    // A mode-override re-entry rebuilds the engine from the same dataset —
    // the geometry hand-off must not double-normalize the retained parse.
    viewer.view("volume").configure({ tools: { crosshair: true } });
    await viewer.ready;
    expect(viewer.status).toBe("ready");
    expect(viewer.engine!.view("main").getLayerStatus("volume-mesh")).toEqual({ status: "ready" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still one fetch, across the rebuild
  });
});
