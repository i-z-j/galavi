/**
 * State schema tests: the portable State document in `src/state/schema.ts`.
 *
 * - `validateState` shape-checks every section, rejects unknown keys, and
 *   returns a canonical deep clone;
 * - function-backed values (e.g. `Data.fetch`) and runtime values (e.g. a
 *   parsed `Data.geometry`'s typed arrays) are REJECTED with an actionable
 *   path — never silently dropped;
 * - transport is plain JSON: `JSON.stringify` / `JSON.parse` round-trips
 *   through `validateState`;
 * - `normalizeState` applies the live-scene defaults (render visibility,
 *   camera clones) and passes the unified facade sections through.
 */
import { describe, expect, test } from "vitest";
import {
  normalizeInitialState,
  normalizeState,
  validateState,
} from "../../src/state";
import type { State } from "../../src/state";

// ============================================================================
// FIXTURES
// ============================================================================

/** A representative, fully portable State (Unicode labels included). */
const STATE: State = {
  physical: {
    spatial: { size: [10, 10, 5], unit: "µm", spacing: [0.1, 0.1, 0.2] },
  },
  layers: [
    {
      id      : "volume-c0",
      type    : "volume",
      data    : { url: "https://example.test/image.zarr" },
      render  : { colormap: "magma", contrastLimits: [0.1, 0.9], volumeProjection: "minip" },
      options : { selection: { c: 0 } },
    },
    { id: "annotations", type: "shapes", render: { visible: true } },
  ],
  exploration: {
    camera: { navMode: "fly", projMode: "orthographic", position: [2, 2, 12], target: [2, 2, 4] },
  },
  composition: { type: "volume", config: { stride: 2 } },
  channels: [
    { index: 0, label: "DAPI µm 通道", visible: true, color: "#00B0FF", contrast: [0.1, 0.9] },
    { index: 1, label: "GFP", visible: false, color: "#FF3D3D", contrast: [0, 1] },
  ],
  projection: "minip",
  tools: { roi: { rois: [{ min: [0, 0, 0], max: [1, 2, 3] }], activeIndex: 0 } },
  compositions: { volume: { channels: [{ index: 0, contrast: [0, 0.5] }] } },
};

function expectInvalid(fn: () => unknown, pattern: RegExp): void {
  expect(fn).toThrowError(pattern);
}

// ============================================================================
// VALIDATION + JSON ROUND TRIP
// ============================================================================

describe("validateState", () => {
  test("accepts a portable document and returns a canonical deep clone", () => {
    const validated = validateState(STATE);
    expect(validated).toEqual(STATE);
    expect(validated).not.toBe(STATE);
    expect(validated.layers![0]).not.toBe(STATE.layers![0]);
  });

  test("JSON is the transport: stringify → parse → validate round-trips", () => {
    const restored = validateState(JSON.parse(JSON.stringify(STATE)));
    expect(restored).toEqual(STATE);
  });

  test("an runtime-path document (physical/layers/exploration only) stays valid", () => {
    const engineState: State = {
      layers: [{ id: "volume-c0", type: "volume", data: { url: "mem://x" } }],
      exploration: {
        camera: { navMode: "orbit", projMode: "perspective", position: [0, 0, 1], target: [0, 0, 0] },
      },
    };
    expect(validateState(engineState)).toEqual(engineState);
  });

  test("invalid documents are rejected with an actionable path", () => {
    expectInvalid(() => validateState(null), /must be a State object/);
    expectInvalid(() => validateState([1, 2, 3]), /must be a State object/);
    expectInvalid(
      () => validateState({ ...STATE, bogus: true }),
      /unknown key "bogus"/,
    );
    // exploration is required.
    const { exploration: _dropped, ...noExploration } = STATE;
    expectInvalid(() => validateState(noExploration), /exploration/);
    // layers is OPTIONAL on the document (facade viewers omit it — the
    // composition re-derives them on restore).
    const { layers: _droppedLayers, ...noLayers } = STATE;
    expect(validateState(noLayers).layers).toBeUndefined();
    expectInvalid(
      () => validateState({ ...STATE, exploration: { camera: { target: [0, 0, 0] } } }),
      /exploration\.camera/,
    );
    expectInvalid(
      () => validateState({
        ...STATE,
        exploration: { camera: { navMode: "drive", projMode: "orthographic", position: [0, 0, 1], target: [0, 0, 0] } },
      }),
      /navMode/,
    );
    expectInvalid(
      () => validateState({ ...STATE, layers: [{ id: "", type: "volume" }] }),
      /layers\[0\]\.id/,
    );
    expectInvalid(
      () => validateState({ ...STATE, layers: [{ id: "a", type: "volume", extra: 1 }] }),
      /layers\[0\]: unknown key "extra"/,
    );
    expectInvalid(
      () => validateState({ ...STATE, layers: [{ id: "a", type: "volume", render: { opacity: 2 } }] }),
      /render\.opacity/,
    );
    expectInvalid(
      () => validateState({ ...STATE, channels: [{ index: 0 }] }),
      /channels\[0\]/,
    );
    expectInvalid(
      () => validateState({
        ...STATE,
        channels: [{ index: 0, label: "a", visible: true, color: "#00B0FF", contrast: [0.9, 0.1] }],
      }),
      /channels\[0\]: contrast/,
    );
    expectInvalid(() => validateState({ ...STATE, projection: "sum" }), /projection/);
    expectInvalid(() => validateState({ ...STATE, composition: { config: {} } }), /composition\.type/);
    expectInvalid(() => validateState({ ...STATE, tools: { roi: 42 } }), /tools\.roi/);
  });

  test("function-backed values are rejected, never silently dropped", () => {
    // A runtime fetch on a layer's data names its path.
    expectInvalid(
      () => validateState({
        ...STATE,
        layers: [{ id: "volume-c0", type: "volume", data: { fetch: async () => new ArrayBuffer(0) } }],
      } as never),
      /layers\[0\]\.data\.fetch is a function/,
    );
    // A callback smuggled into tool values is caught by the JSON guard.
    expectInvalid(
      () => validateState({ ...STATE, tools: { roi: { onRoisChange: () => {} } } } as never),
      /tools\.roi\.onRoisChange is a function/,
    );
  });

  test("runtime values (typed arrays, class instances) are rejected", () => {
    // A pre-parsed Data.geometry is runtime-bound — not a portable document.
    expectInvalid(
      () => validateState({
        ...STATE,
        layers: [{
          id: "mesh",
          type: "surface",
          data: { geometry: { positions: new Float32Array([0, 0, 0]), vertexCount: 1 } },
        }],
      } as never),
      /layers\[0\]\.data\.geometry/,
    );
    // Non-finite numbers are not JSON.
    expectInvalid(
      () => validateState({
        ...STATE,
        exploration: { camera: { navMode: "orbit", projMode: "perspective", position: [0, 0, Number.POSITIVE_INFINITY], target: [0, 0, 0] } },
      }),
      /position/,
    );
  });
});

// ============================================================================
// NORMALIZATION
// ============================================================================

describe("normalizeState", () => {
  test("applies layer render defaults and clones camera vectors", () => {
    const input: State = {
      layers: [
        { id: "a", type: "volume" },
        { id: "b", type: "shapes", render: { visible: false } },
      ],
      exploration: STATE.exploration,
    };
    const out = normalizeState(input);
    expect(out.layers[0].render).toEqual({ visible: true });
    expect(out.layers[1].render).toEqual({ visible: false });
    expect(out.exploration.camera.position).toEqual(STATE.exploration.camera.position);
    expect(out.exploration.camera.position).not.toBe(STATE.exploration.camera.position);
  });

  test("the unified facade sections pass through (cloned)", () => {
    const out = normalizeState(STATE);
    expect(out.composition).toEqual(STATE.composition);
    expect(out.composition).not.toBe(STATE.composition);
    expect(out.channels).toEqual(STATE.channels);
    expect(out.channels![0]).not.toBe(STATE.channels![0]);
    expect(out.projection).toBe("minip");
    expect(out.tools).toEqual(STATE.tools);
    expect(out.compositions).toEqual(STATE.compositions);
  });

  test("runtime bindings pass through untouched (normalization is not validation)", () => {
    const fetcher = async () => new ArrayBuffer(0);
    const out = normalizeState({
      layers: [{ id: "volume-c0", type: "volume", data: { fetch: fetcher } }],
      exploration: STATE.exploration,
    });
    expect(out.layers[0].data?.fetch).toBe(fetcher);
  });

  test("a validated document survives a normalize → JSON → validate loop", () => {
    const normalized = normalizeState(validateState(JSON.parse(JSON.stringify(STATE))));
    expect(validateState(JSON.parse(JSON.stringify(normalized)))).toEqual({
      ...STATE,
      layers: STATE.layers!.map((layer) => ({
        ...layer,
        render: { visible: true, ...layer.render },
      })),
    });
  });

  test("normalizeInitialState merges the shared defaults", () => {
    const out = normalizeInitialState({ layers: [], exploration: STATE.exploration });
    expect(out.layers).toEqual([]);
    expect(out.exploration.camera.position).toEqual(STATE.exploration.camera.position);
    const withDefaults = normalizeInitialState({
      layers: [],
      exploration: { camera: { position: [0, 0, 1], target: [0, 0, 0] } } as never,
    });
    expect(withDefaults.exploration.camera.navMode).toBe("orbit");
    expect(withDefaults.exploration.camera.projMode).toBe("perspective");
  });
});
