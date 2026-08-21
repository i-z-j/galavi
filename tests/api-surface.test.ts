/**
 * Entry surface tests (API-6): `galavi` (common root), `galavi/advanced`
 * (low-level authoring), and `galavi/ome-zarr` expose exactly their intended
 * surfaces.
 *
 * - Compile-time (`bun run typecheck`): `@ts-expect-error` import probes pin
 *   the intentional break — names moved to `galavi/advanced` must NOT be
 *   importable from the root (no re-export aliases).
 * - Runtime: explicit export-list assertions per entry (not a snapshot), plus
 *   the advanced entry re-exporting the common root.
 *
 * The packed-consumer equivalents live in scripts/check-pack.mjs; the
 * bundle-level import-graph/side-effect checks live there too.
 */
import { describe, expect, test } from "vitest";
import * as root from "../src/index";
import * as advanced from "../src/advanced";

// === Compile probes: the root carries the common surface ===
import type {
  DatasetConfig,
  DatasetConfigMap,
  PhysicalSpace,
  Vec3,
  ViewerConfig,
  ViewerRoiActiveChangeEvent,
  ViewerRoiChangeEvent,
  ViewerRoiOptions,
  ViewerToolsConfig,
} from "../src/index";

// === Compile probes: advanced carries the low-level surface ===
import type {
  LayerConfig,
  LayerPatch,
  RoiSelectorOverlayOptions,
  State,
  ViewConfig,
  ViewerEngineConfig,
  VolumeOptions,
} from "../src/advanced";

// === Compile probes: moved names are absent from the root (API-6) ===
// Each @ts-expect-error fails the typecheck if the name ever returns to the
// root entry.

// @ts-expect-error — the engine moved to galavi/advanced (API-6)
import { ViewerEngine as ViewerEngineFromRoot } from "../src/index";
// @ts-expect-error — the engine factory moved to galavi/advanced (API-6)
import { createViewerEngine as createViewerEngineFromRoot } from "../src/index";
// @ts-expect-error — layer authoring moved to galavi/advanced (API-6)
import { BaseLayer as BaseLayerFromRoot } from "../src/index";
// @ts-expect-error — built-in overlays moved to galavi/advanced (API-6)
import { RoiSelectorOverlay as RoiSelectorOverlayFromRoot } from "../src/index";
// @ts-expect-error — view authoring moved to galavi/advanced (API-6)
import { BaseView as BaseViewFromRoot } from "../src/index";
// @ts-expect-error — the plugin registry moved to galavi/advanced (API-6)
import { registerLayer as registerLayerFromRoot } from "../src/index";
// @ts-expect-error — the built-in mesh dataset moved to galavi/advanced (API-6)
import { MeshDataset as MeshDatasetFromRoot } from "../src/index";
// @ts-expect-error — tile utilities moved to galavi/advanced (API-6)
import { TilePool as TilePoolFromRoot } from "../src/index";
// @ts-expect-error — engine defaults moved to galavi/advanced (API-6)
import { DEFAULT_FOV as DEFAULT_FOVFromRoot } from "../src/index";
// @ts-expect-error — the raw scene model moved to galavi/advanced (API-6)
import type { State as StateFromRoot } from "../src/index";
// @ts-expect-error — callback-bearing overlay options moved to galavi/advanced (API-6)
import type { RoiSelectorOverlayOptions as RoiSelectorOverlayOptionsFromRoot } from "../src/index";

// The low-level ROI overlay options keep their callbacks on the advanced
// entry (API-4): this assignment must compile.
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
// RUNTIME EXPORT LISTS
// ============================================================================

/** Values the common root must export. */
const ROOT_VALUES = [
  // Viewer facade
  "createViewer",
  "Viewer",
  "ViewerSupersededError",
  // Dataset opening + registration
  "openDataset",
  "Dataset",
  "registerDataset",
  // Dataset descriptor helper (the "mesh" kind is a core built-in)
  "mesh",
  // Theme helpers
  "DEFAULT_THEME",
  "FUI_THEME",
  "PRECISION_THEME",
  "resolveTheme",
  "mergeTheme",
  "applyThemeTo",
] as const;

/** Values that must NOT leak into the common root (they live in advanced). */
const MOVED_TO_ADVANCED = [
  // Engine
  "ViewerEngine",
  "createViewerEngine",
  // Registries
  "registerControl",
  "registerOverlay",
  "registerLayer",
  "registerView",
  // Dataset authoring
  "MeshDataset",
  "getDatasetCapabilities",
  // Base + built-in classes
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
  // Utils + defaults
  "TilePool",
  "TileManager",
  "MIN_VEC4_BUFFER",
  "DEFAULT_FOV",
  "planTiles",
  "resolveAxes",
  "normalizeHexColor",
] as const;

describe("entry surfaces (API-6)", () => {
  test("the root exports the common facade values", () => {
    for (const name of ROOT_VALUES) {
      expect((root as Record<string, unknown>)[name], `galavi is missing ${name}`).toBeDefined();
    }
  });

  test("moved names are absent from the root", () => {
    for (const name of MOVED_TO_ADVANCED) {
      expect(name in root, `galavi must not re-export ${name} (use galavi/advanced)`).toBe(false);
    }
  });

  test("the advanced entry carries the low-level surface and the common root", () => {
    for (const name of MOVED_TO_ADVANCED) {
      expect((advanced as Record<string, unknown>)[name], `galavi/advanced is missing ${name}`).toBeDefined();
    }
    for (const name of ROOT_VALUES) {
      expect((advanced as Record<string, unknown>)[name], `galavi/advanced is missing root name ${name}`).toBeDefined();
    }
  });

  test("the compile probes stay referenced", () => {
    // The event payload types are type-only; reference them structurally so
    // the probes above cannot rot into unused locals.
    const event: ViewerRoiChangeEvent = {
      rois   : [],
      change : { index: 0, kind: "create", phase: "commit" },
      viewId : "main",
      mode   : "slice",
    };
    const active: ViewerRoiActiveChangeEvent = { activeIndex: null, viewId: "main", mode: "slice" };
    void event;
    void active;
    void lowLevelRoiOptions;
    void highLevelRoiOptions;
    const typeProbes: [
      DatasetConfig?,
      PhysicalSpace?,
      Vec3?,
      ViewerConfig?,
      ViewerToolsConfig?,
      LayerConfig?,
      LayerPatch?,
      State?,
      ViewConfig?,
      ViewerEngineConfig?,
      VolumeOptions?,
    ] = [];
    void typeProbes;
    const mapProbe: DatasetConfigMap[keyof DatasetConfigMap] = { type: "mesh", source: "mem://x" };
    void mapProbe;
    // Moved-name probes (the imports above must keep erroring).
    void ViewerEngineFromRoot;
    void createViewerEngineFromRoot;
    void BaseLayerFromRoot;
    void RoiSelectorOverlayFromRoot;
    void BaseViewFromRoot;
    void registerLayerFromRoot;
    void MeshDatasetFromRoot;
    void TilePoolFromRoot;
    void DEFAULT_FOVFromRoot;
    type StateProbe = StateFromRoot;
    type RoiOptionsProbe = RoiSelectorOverlayOptionsFromRoot;
    void (0 as unknown as StateProbe | undefined);
    void (0 as unknown as RoiOptionsProbe | undefined);
  });
});
