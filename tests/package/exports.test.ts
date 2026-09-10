/**
 * Entry surface tests: `galavi` (the ONE main entry — facade + state +
 * dataset + composition + runtime + primitives + utils) and `galavi/ome-zarr`
 * expose exactly their intended surfaces.
 *
 * - Compile-time (`bun run typecheck`): `@ts-expect-error` import probes pin
 *   the negative surface — names that are intentionally NOT part of the API
 *   (`DatasetCapabilities`, `DefaultLayersOptions`, `getDatasetCapabilities`,
 *   `ImageDataset`, a mode vocabulary, `createSliceGrid`, a state codec)
 *   must not resolve anywhere; the package exposes only its documented
 *   entries.
 * - Runtime: the EXACT export list per entry (not a snapshot, not a subset).
 *
 * The packed-consumer equivalents live in scripts/check-pack.mjs; the
 * bundle-level import-graph/side-effect checks live there too.
 */
import { describe, expect, test } from "vitest";
import * as root from "../../src/index";
import * as omeZarrEntry from "../../src/dataset/adapters/ome-zarr";
import * as stateEntry from "../../src/state";
// === Compile probes: the root carries the full surface ===
import type {
  DatasetConfig,
  DatasetConfigMap,
  DatasetResource,
  DatasetResourceMap,
  ImagePyramidResource,
  MeshResource,
  PhysicalSpace,
  State,
  Vec3,
  ViewerConfig,
  ViewerRoiActiveChangeEvent,
  ViewerRoiChangeEvent,
  ViewerRoiOptions,
  ViewerToolsConfig,
} from "../../src/index";

// === Compile probes: the low-level surface lives on the root too ===
// (facade and low-level runtime share the single root entry).
import type {
  CompositionPlan,
  LayerConfig,
  LayerPatch,
  RoiSelectorOverlayOptions,
  ViewConfig,
  ViewerComposition,
  ViewerRuntimeConfig,
  VolumeOptions,
} from "../../src/index";
import {
  BaseLayer,
  BaseView,
  createViewerRuntime,
  MeshDataset,
  registerLayer,
  RoiSelectorOverlay,
  TilePool,
  ViewerRuntime,
  DEFAULT_FOV,
} from "../../src/index";
void [BaseLayer, BaseView, createViewerRuntime, MeshDataset, registerLayer,
  RoiSelectorOverlay, TilePool, ViewerRuntime, DEFAULT_FOV];

// === Compile probes: names outside the surface stay unresolvable ===
// (Package-entry boundaries are probed in scripts/check-pack.mjs — only
// source modules can be probed here.)

// @ts-expect-error — datasets no longer advertise viewer compositions; compositions decide support
import type { DatasetCapabilities as DatasetCapabilitiesRemoved } from "../../src/index";
// @ts-expect-error — datasets no longer build layer configs; compositions translate resources
import type { DefaultLayersOptions as DefaultLayersOptionsRemoved } from "../../src/index";
// @ts-expect-error — the capabilities helper was removed with the Dataset presentation contract
import { getDatasetCapabilities as getDatasetCapabilitiesRemoved } from "../../src/index";
// @ts-expect-error — renamed OMEZarrDataset; there is no alias
import { ImageDataset as ImageDatasetRemoved } from "../../src/dataset/adapters/ome-zarr";
// @ts-expect-error — there is no createDataset; openDataset is the only generic opener
import { createDataset as createDatasetAbsent } from "../../src/index";
// @ts-expect-error — there is no source registry; registerDatasetAdapter is the extension point
import { registerSource as registerSourceAbsent } from "../../src/index";
// @ts-expect-error — there is no mode vocabulary; ViewerConfig takes `composition`
const staleModeConfig: ViewerConfig = { mode: "quad" };
// @ts-expect-error — there is no mode vocabulary; transitions are `await viewer.setComposition(...)`
import type { ViewerMode as ViewerModeRemoved } from "../../src/index";
// @ts-expect-error — the unified State is the portable document; there is no ViewerState
import type { ViewerState as ViewerStateRemoved } from "../../src/index";
// @ts-expect-error — composition: { type: "grid" } is the grid path; no standalone grid helper exists
import { createSliceGrid as createSliceGridRemoved } from "../../src/index";
// @ts-expect-error — per-composition overrides live under `compositions`; there is no modeOverrides key
const staleOverrides: ViewerConfig = { modeOverrides: {} };
void staleOverrides;
// @ts-expect-error — state transport is plain JSON; no codec helpers exist
import { encodeState as encodeStateFromRoot } from "../../src/index";
// @ts-expect-error — state transport is plain JSON; no codec helpers exist
import { decodeState as decodeStateFromRoot } from "../../src/index";
// @ts-expect-error — renamed dataSourceChanged and moved to utils/data-source.ts; there is no alias
import { sourceChanged as sourceChangedRemoved } from "../../src/index";
// @ts-expect-error — the duplicate tile-source type was removed; use Data/ImagePyramidResource + TileLoader<T>
import type { TileSource as TileSourceRemoved } from "../../src/index";
// tileId is still exported, but the old tileId(coord: TileCoord) call shape is gone.
import { tileId } from "../../src/index";
import type { TileCoord } from "../../src/index";
// @ts-expect-error — tileId takes (level, coordinates); a TileCoord object is no longer accepted
const staleTileIdCall: () => string = () => tileId({ level: 0, position: [0, 0, 0] } as TileCoord);
void staleTileIdCall;
const currentTileIdCall: string = tileId(0, [0, 0, 0]);
void currentTileIdCall;

// The `composition` vocabulary compiles on ViewerConfig.
const quadCompositionConfig: ViewerConfig = { composition: { type: "quad" } };
void quadCompositionConfig;

// The low-level ROI overlay options keep their callbacks on the root
// entry — this assignment must compile.
const lowLevelRoiOptions: RoiSelectorOverlayOptions = {
  onRoisChange: (rois, change) => { void rois; void change; },
  onActiveIndexChange: (index) => { void index; },
};

// The high-level ROI tool options are the serializable subset.
const highLevelRoiOptions: ViewerRoiOptions = {
  visible: true,
  enabled: true,
  rois: [{ min: [0, 0, 0], max: [1, 1, 1] }],
  activeIndex: null,
};

// ============================================================================
// RUNTIME EXPORT LISTS (exact)
// ============================================================================

/** Values the root entry must export — the exact set (facade + low-level surface). */
const ROOT_VALUES = [
  // Viewer facade
  "createViewer",
  "Viewer",
  "ViewerSupersededError",
  // Runtime (low-level orchestrator)
  "ViewerRuntime",
  "createViewerRuntime",
  // Dataset opening + registration
  "openDataset",
  "Dataset",
  "registerDatasetAdapter",
  // Registries (the extension points)
  "registerComposition",
  "registerControl",
  "registerOverlay",
  "registerLayer",
  "registerView",
  // Resolution-boundary error (unknown capability references)
  "CapabilityResolutionError",
  // Dataset descriptor helper (the "mesh" kind is a core built-in)
  "mesh",
  // Dataset authoring
  "MeshDataset",
  // State schema (validation + live-scene normalization)
  "normalizeState",
  "validateState",
  // Base + built-in primitive classes
  "BaseControl",
  "BaseOverlay",
  "CrosshairOverlay",
  "RulerOverlay",
  "RoiSelectorOverlay",
  "MagnifierOverlay",
  "FoldablePanelOverlay",
  "BaseLayer",
  "TiledImageLayer",
  "BaseView",
  // Theme helpers
  "DEFAULT_THEME",
  "FUI_THEME",
  "PRECISION_THEME",
  "resolveTheme",
  "mergeTheme",
  "applyThemeTo",
  // Utils + defaults
  "TilePool",
  "TileLoadQueue",
  "TileManager",
  "MIN_VEC4_BUFFER",
  "DEFAULT_FOV",
  "planTiles",
  "resolveAxes",
  "normalizeHexColor",
  "UNIT_CUBE",
  "EMPTY_VERTEX_BUFFER",
  "APPEARANCE_PRESETS",
  "CHANNEL_FALLBACK_COLORS",
  "COLORMAP_NAMES",
  "CONTRAST_RANGE",
  "VOLUME_PREVIEW_MAX_CHUNK_TEXELS",
  "VOLUME_PREVIEW_MAX_SLABS",
  "VOLUME_PREVIEW_MAX_TILES",
  "VOLUME_PREVIEW_POOL_HEADROOM",
  "aabbFromPositions",
  "buildContrastLimits",
  "buildTileFetcher",
  "cameraAngles",
  "cameraBasis",
  "cameraDistance",
  "clampContrastLimits",
  "clampPitch",
  "computeForward",
  "computePosition",
  "countPyramidLevelTiles",
  "cross",
  "dataSourceChanged",
  "dot",
  "dtypeNormalization",
  "fitSliceCamera",
  "floatToFloat16",
  "frameVolumeCamera",
  "getChannelColor",
  "getColormapLUT",
  "makeFloat16Encoder",
  "normalize",
  "normalizeDrag",
  "normalizeWheel",
  "optArray",
  "optAxis",
  "optBoolean",
  "optNumber",
  "optNumberRecord",
  "optString",
  "optVec2",
  "optVec3",
  "parseHexColor",
  "physicalToSliceScreen",
  "physicalToVolumeScreen",
  "pickPyramidLevel",
  "planVolumePreview",
  "resolveAppearancePreset",
  "resolveDataUrl",
  "screenToSlicePhysical",
  "screenToVolumeTargetPlane",
  "sliceUnitsPerPixel",
  "subtract",
  "tileId",
  "volumeUnitsPerPixel",
] as const;

/** Values `galavi/ome-zarr` must export — the exact set. */
const OME_ZARR_VALUES = [
  // The dataset kind class (format-specific, not a generic image dataset)
  "OMEZarrDataset",
  // Opening + descriptor helper
  "openOMEZarrDataset",
  "openOMEZarr",
  "omeZarr",
  // Plate helpers
  "openOMEZarrPlate",
  // Store + fetch primitives
  "createStore",
  "withRetry",
  "fetch2DPlane",
  // Packing + metadata utilities
  "toFloat16",
  "packPlaneToFloat16",
  "deriveLevelScale",
  "getNormalizedDisplayContrast",
  "getPhysicalSpace",
  "getVolumeTransform",
  "normalizeUnit",
] as const;

/** Values the state module must export — the exact set (schema validation + normalization). */
const STATE_VALUES = [
  "normalizeInitialState",
  "normalizePhysicalSpace",
  "normalizeState",
  "validateJsonObject",
  "validateState",
] as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("entry surfaces", () => {
  test("the root exports exactly the full surface values", () => {
    expect(Object.keys(root).sort()).toEqual(sorted(ROOT_VALUES));
  });

  test("the ome-zarr entry exports exactly its format surface", () => {
    expect(Object.keys(omeZarrEntry).sort()).toEqual(sorted(OME_ZARR_VALUES));
  });

  test("the state module exports exactly the schema surface", () => {
    expect(Object.keys(stateEntry).sort()).toEqual(sorted(STATE_VALUES));
  });

  test("removed names exist on no entry", () => {
    for (const entry of [root, omeZarrEntry, stateEntry]) {
      expect("getDatasetCapabilities" in entry).toBe(false);
      expect("ImageDataset" in entry).toBe(false);
      expect("createDataset" in entry).toBe(false);
      expect("registerSource" in entry).toBe(false);
      expect("createSliceGrid" in entry).toBe(false);
      expect("sourceChanged" in entry).toBe(false);
    }
  });

  test("no state codec helpers exist on any entry", () => {
    for (const entry of [root, omeZarrEntry, stateEntry]) {
      expect("encodeState" in entry).toBe(false);
      expect("decodeState" in entry).toBe(false);
      expect("StateCodecError" in entry).toBe(false);
    }
  });

  test("the compile probes stay referenced", () => {
    // The event payload types are type-only; reference them structurally so
    // the probes above cannot rot into unused locals.
    const event: ViewerRoiChangeEvent = {
      rois        : [],
      change      : { index: 0, kind: "create", phase: "commit" },
      viewId      : "main",
      composition : "slice",
    };
    const active: ViewerRoiActiveChangeEvent = {
      activeIndex: null, viewId: "main", composition: "slice",
    };
    void event;
    void active;
    void lowLevelRoiOptions;
    void highLevelRoiOptions;
    void staleModeConfig;
    const typeProbes: [
      CompositionPlan?,
      DatasetConfig?,
      DatasetResource?,
      ImagePyramidResource?,
      MeshResource?,
      PhysicalSpace?,
      State?,
      Vec3?,
      ViewerComposition?,
      ViewerConfig?,
      ViewerToolsConfig?,
      LayerConfig?,
      LayerPatch?,
      ViewConfig?,
      ViewerRuntimeConfig?,
      VolumeOptions?,
    ] = [];
    void typeProbes;
    // State is the ONE portable document (facade + runtime paths): a facade
    // document carries dataset/composition/channels/camera — no layers.
    const stateProbe: State = {
      dataset     : { type: "mesh", source: "mem://x" },
      composition : { type: "volume" },
      channels    : [{ index: 0, label: "a", visible: true, color: "#00B0FF", contrast: [0, 1] }],
      projection  : "mip",
      exploration : {
        camera: {
          navMode: "orbit", projMode: "perspective", position: [0, 0, 1], target: [0, 0, 0],
        },
      },
    };
    void stateProbe;
    const mapProbe: DatasetConfigMap[keyof DatasetConfigMap] = { type: "mesh", source: "mem://x" };
    void mapProbe;
    const resourceMapProbe: DatasetResourceMap[keyof DatasetResourceMap] = {
      id: "mesh", kind: "mesh", source: "mem://x",
    };
    void resourceMapProbe;
    // Codec probes (must keep erroring).
    void encodeStateFromRoot;
    void decodeStateFromRoot;
    // Removed-name probes (must keep erroring).
    type CapabilitiesProbe = DatasetCapabilitiesRemoved;
    type DefaultLayersProbe = DefaultLayersOptionsRemoved;
    type ViewerModeProbe = ViewerModeRemoved;
    type ViewerStateProbe = ViewerStateRemoved;
    type TileSourceProbe = TileSourceRemoved;
    void (0 as unknown as CapabilitiesProbe | undefined);
    void (0 as unknown as DefaultLayersProbe | undefined);
    void (0 as unknown as ViewerModeProbe | undefined);
    void (0 as unknown as ViewerStateProbe | undefined);
    void (0 as unknown as TileSourceProbe | undefined);
    void getDatasetCapabilitiesRemoved;
    void ImageDatasetRemoved;
    void createDatasetAbsent;
    void registerSourceAbsent;
    void createSliceGridRemoved;
    void sourceChangedRemoved;
  });
});
