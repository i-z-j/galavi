/**
 * High-level Viewer layer-readiness tests.
 *
 * `createViewer` / `viewer.open` / composition transitions resolve `viewer.ready`
 * only once every unique generated layer reports structural readiness —
 * tiled layers count as ready when their source/pyramid is available (NOT
 * full tile refinement), source-backed layers (surfaces) once fetched and
 * parsed. A failed source rejects `createViewer`/`viewer.ready`, flips
 * `viewer.status` to `"error"`, and recovers on a later open.
 *
 * Fetch-gated cases use a URL-backed `"mesh"` resource (no pre-parsed
 * geometry): the generated surface layer fetches at scene-build time, so the
 * global fetch stub controls the layer's settle. Multi-view structural
 * coverage uses a 3D `"image-pyramid"` resource through the quad composition.
 * Headless: fake WebGPU device + fake DOM (rAF stubbed — no render pass runs).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createViewer,
  Dataset,
  MeshDataset,
  registerDatasetAdapter,
  type DatasetConfig,
  type Viewer,
} from "../../src/index";
import { SurfaceLayer } from "../../src/primitives/layer";
import { datasetRegistry } from "../../src/registry";
import type { ImagePyramid } from "../../src/state/schema";

// ============================================================================
// STUB DATASET KIND — mesh or 3D-image primary resource per fixture config
// ============================================================================

const KIND = "readiness-stub";

declare module "galavi" {
  interface DatasetConfigMap {
    "readiness-stub": { type: "readiness-stub"; source: string };
  }
}

const DESC_MESH: DatasetConfig = { type: KIND, source: "mem://scene-mesh" };
const DESC_IMAGE: DatasetConfig = { type: KIND, source: "mem://scene-image" };

const PYRAMID_3D: ImagePyramid = {
  levels: [{ path: "0", shape: [8, 8, 4], chunkSize: [4, 4, 2], scale: [1, 1, 2] }],
};

class StubDataset extends Dataset {
  override async load(): Promise<void> {
    this.physical = { spatial: { size: [10, 10, 10], spacing: [1, 1, 1], origin: [0, 0, 0] } };
    this.channels = [{ index: 0, label: "s", color: "#FFFFFF", contrast: [0, 1], visible: true }];
    if (this.config.source === DESC_IMAGE.source) {
      this.resources = [{
        id: "image",
        kind: "image-pyramid",
        pyramid: PYRAMID_3D,
        fetch: async () => new ArrayBuffer(0),
        physical: this.physical,
        dimensions: [],
        defaultSelection: { c: 0 },
        channels: this.channels,
      }];
    } else {
      // URL-backed mesh, no pre-parsed geometry: the generated surface layer
      // fetches at scene-build time.
      this.resources = [{ id: "mesh", kind: "mesh", source: "mem://surf-volume.obj" }];
    }
    this.primaryResourceId = this.resources[0].id;
  }

  override dispose(): void {}
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
  registerDatasetAdapter(KIND, (config) => new StubDataset(config));
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

describe("Viewer awaits generated layer readiness", () => {
  test("createViewer resolves only after the surface layer loads", async () => {
    gates.set("mem://surf-volume.obj", makeGate());
    let settled = false;
    const pending = createViewer(makeFakeCanvas(), { dataset: DESC_MESH }).then((viewer) => {
      settled = true;
      return track(viewer);
    });

    await flushMicrotasks();
    expect(settled).toBe(false); // gated on the layer's fetch, not just the dataset

    gates.get("mem://surf-volume.obj")!.resolve(okResponse());
    const viewer = await pending;
    expect(settled).toBe(true);
    expect(viewer.status).toBe("ready");
    expect(viewer.runtime!.view("main").getLayerStatus("volume-mesh")).toEqual({ status: "ready" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // one fetch for the one layer
  });

  test("a failing surface rejects open and viewer.ready; status records the error", async () => {
    failing.set("mem://surf-volume.obj", 404);
    const viewer = track(await createViewer(makeFakeCanvas()));
    await expect(viewer.open(DESC_MESH)).rejects.toThrow("Surface fetch failed: 404");
    expect(viewer.status).toBe("error");
    expect((viewer.error as Error).message).toBe("Surface fetch failed: 404");
    await expect(viewer.ready).rejects.toThrow("Surface fetch failed: 404");

    // Recovery: a later open with the source fixed becomes ready.
    failing.delete("mem://surf-volume.obj");
    await viewer.open(DESC_MESH);
    expect(viewer.status).toBe("ready");
    expect(viewer.error).toBeUndefined();
  });

  test("createViewer rejects when a generated layer fails", async () => {
    failing.set("mem://surf-volume.obj", 500);
    await expect(createViewer(makeFakeCanvas(), { dataset: DESC_MESH })).rejects.toThrow(
      "Surface fetch failed: 500",
    );
  });

  test("the quad composition awaits every unique layer across its four views", async () => {
    let settled = false;
    const pending = createViewer(makeFakeContainer(), { dataset: DESC_IMAGE, composition: { type: "quad" } })
      .then((viewer) => {
        settled = true;
        return track(viewer);
      });
    const viewer = await pending;
    expect(settled).toBe(true);
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedComposition).toBe("quad");
    for (const prefix of ["quad-xy", "quad-xz", "quad-yz", "quad-3d"]) {
      expect(viewer.runtime!.view(prefix).getLayerStatus(`${prefix}-c0`)).toEqual({ status: "ready" });
    }
  });

  test("composition transitions re-await the new composition's generated layers", async () => {
    const viewer = track(await createViewer(makeFakeContainer(), { dataset: DESC_IMAGE }));
    expect(viewer.status).toBe("ready");
    expect(viewer.resolvedComposition).toBe("volume");

    let settled = false;
    const transition = viewer.setComposition({ type: "quad" }).then(() => { settled = true; });
    await transition;
    expect(settled).toBe(true);
    expect(viewer.resolvedComposition).toBe("quad");
    for (const prefix of ["quad-xy", "quad-xz", "quad-yz", "quad-3d"]) {
      expect(viewer.runtime!.view(prefix).getLayerStatus(`${prefix}-c0`)).toEqual({ status: "ready" });
    }
  });
});

// ============================================================================
// MESH — ONE FETCH, ONE PARSE, READY AFTER ADOPTION
// ============================================================================

describe("MeshDataset viewer readiness", () => {
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

  test("exactly one network fetch total; the surface layer adopts the resource's parsed geometry", async () => {
    bodies.set("mem://mesh.obj", MESH_OBJ);
    const viewer = track(await createViewer(makeFakeCanvas(), {
      dataset: { type: "mesh", source: "mem://mesh.obj" },
    }));
    expect(viewer.dataset).toBeInstanceOf(MeshDataset);
    expect(viewer.status).toBe("ready");

    // The dataset's load() fetched once; the layer consumed the mesh
    // resource's geometry — it never fetched the URL itself.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("mem://mesh.obj");
    expect(viewer.dataset!.resource("mesh")?.geometry?.vertexCount).toBe(12);

    const layer = viewer.runtime!.view("main").getLayer("volume-mesh");
    expect(layer).toBeInstanceOf(SurfaceLayer);
    expect(viewer.runtime!.view("main").getLayerStatus("volume-mesh")).toEqual({ status: "ready" });
    // The adopted geometry is parsed and fitted (4 triangles → 12 vertices).
    expect((layer as SurfaceLayer).getPositions()).toBeInstanceOf(Float32Array);
    expect((layer as SurfaceLayer).getPositions()!.length).toBe(12 * 3);
  });

  test("the surface layer keeps working when the same runtime rebuilds from the dataset", async () => {
    bodies.set("mem://mesh.obj", MESH_OBJ);
    const viewer = track(await createViewer(makeFakeCanvas(), {
      dataset: { type: "mesh", source: "mem://mesh.obj" },
    }));
    // A composition-override re-entry rebuilds the runtime from the same dataset —
    // the geometry hand-off must not double-normalize the retained parse.
    viewer.composition("volume").configure({ tools: { crosshair: true } });
    await viewer.ready;
    expect(viewer.status).toBe("ready");
    expect(viewer.runtime!.view("main").getLayerStatus("volume-mesh")).toEqual({ status: "ready" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still one fetch, across the rebuild
  });
});
