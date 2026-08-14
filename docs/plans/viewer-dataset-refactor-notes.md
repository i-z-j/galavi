# Viewer + Dataset refactor notes

Date: 2026-08-14. Scope: `galavi` (primary), `galavi-examples` (migrated), `galavi-ome-zarr-adapter` (untouched, superseded), `cerevi-web` (read-only reference).

## What moved where

| Before | After |
|---|---|
| `src/main.ts` (`Galavi`, `createGalavi`) | `src/viewer.ts` (`ViewerEngine`, `createViewerEngine`) |
| `src/viewer/` (facade `Viewer`, `createViewer`, types) | `src/viewer.ts` (single module, facade + engine + types) |
| `GalaviConfig` (`src/types.ts`) | `ViewerEngineConfig` (`src/types.ts`) |
| `src/dataset.ts` (`ResolvedDataset`, `datasetResolverRegistry`, `openDataset` + cache) | `src/dataset/` (`base.ts`, `index.ts`, `mesh.ts`, `ome-zarr.ts`) |
| `sourceRegistry` / `registerSource` / `ResolvedSource` (`src/registry.ts`) | `datasetRegistry` / `registerDataset` (`src/registry.ts`) — `sourceRegistry` is gone entirely |
| per-layer `Data.source` resolution (`src/layer/tiled-image.ts`) | removed — datasets own source IO; layers consume explicit `pyramid`/`fetch` |
| `@galavi/ome-zarr-adapter` package | `src/dataset/ome-zarr.ts`, published as the `galavi/ome-zarr` subpath |

## Viewer consolidation

`src/viewer.ts` is one module holding two plain classes:

- **`Viewer`** — the public facade. Owns the dataset session (open/mode/channels/controls/tools), device/canvas/render-loop composition (via the engine), and consumes the view/layer/dataset registries. It is never registered as a kind. Mode and camera remain per-view concerns; `viewer.mode` is only a convenience proxy over the generated views. Factory: `createViewer(element, config)`.
- **`ViewerEngine`** — the former `Galavi` orchestrator, renamed. Still the advanced low-level API (full `ViewerEngineConfig` with `state` + named views), root-exported for composition-heavy consumers. `viewer.engine` is the escape hatch (formerly `viewer.galavi`); it is replaced on `open()` and mode transitions.

The old names are removed completely: no `Galavi`, no `createGalavi`, no `GalaviConfig`, no aliases or wrappers anywhere in source, exports, or the built declarations.

One structural note: `src/overlay/magnifier.ts` creates its nested 3D-loupe engine via `await import("../viewer")` because a static import closes a module cycle (`registry → overlay → magnifier → viewer → dataset → registry`). The dynamic import is folded into the single-file bundle by Rollup; no behavior change.

## Dataset architecture

`Dataset` (`src/dataset/base.ts`) is the single abstraction for data semantics + source IO:

- lifecycle: `load()` / `dispose()`
- metadata: `name?`, `physical?`, `dimensions`, `defaultSelection`, `capabilities`, `dtype` (image)
- `channels: DatasetChannel[]` (normalized label/color/contrast/visibility)
- `deriveDefaults(): DatasetDefaults` — what `mode: "auto"` resolves to, plus default selection
- `createDefaultLayers(options: DefaultLayersOptions): LayerConfig[]` — default layer configs per view kind

Built-in kinds: `mesh` (`MeshDataset`, OBJ only, hand-rolled parser reused from the surface layer, zero dependencies). Runtime-registered kinds: `image` (`ImageDataset`, OME-Zarr). There is exactly one registry: `datasetRegistry` in `src/registry.ts` (typed against `dataset/base.ts` only; registry.ts never imports kind modules).

Terminology: OME-NGFF calls pyramid/resolution levels "datasets". Inside `src/dataset/` those are always *resolution level* / *pyramid level* / *multiscale level* — never "dataset".

## sourceRegistry → datasetRegistry migration

The old architecture had two parallel mechanisms: per-layer `Data.source` resolution through `sourceRegistry`, and dataset resolvers through `datasetResolverRegistry` (with a per-source-identity cache). Both are removed. `datasetRegistry` is now the sole dataset/source registration mechanism, following the same `Registry` class and `registerX` helper style as the view/layer/control/overlay siblings.

Behavior notes:

- The per-source-identity resolution cache (`datasetCacheKey`, `invalidateDataset`, `invalidateAllDatasets`) is gone. Each `openDataset(config)` constructs and loads a fresh `Dataset`; disposal is the caller's job (the `Viewer` disposes on supersede/replace/destroy).
- Unknown kinds fail loudly: `Unknown dataset kind: "image" (registered: mesh). Did you mean to import "galavi/ome-zarr"?`
- `State` stays pure JSON: `DatasetConfig` (`{ type, source, ... }`) has the same JSON-serializable contract the old `SourceDescriptor` had.

## Registration contract

New data semantics → new dataset kind. New format of existing semantics → a source registered through the dataset registry. Today there is one source per kind; the seam exists without speculative dispatch machinery.

```ts
import { registerDataset, Dataset, type DatasetConfig } from "galavi";

class MyDataset extends Dataset { /* load/dispose/deriveDefaults/createDefaultLayers */ }
registerDataset("my-kind", (config: DatasetConfig) => new MyDataset(config));
```

Registration is a module-load side effect; applications register their own kinds without modifying galavi. Built-in `mesh` self-registers through the core import chain (`src/dataset/index.ts` → `./mesh`); `image` registers only when `galavi/ome-zarr` is imported. `src/dataset/index.ts` never re-exports `ome-zarr`.

## Mask-dataset seam (future, not implemented)

A future `MaskDataset` (label/segmentation images) follows the same contract:

- `deriveDefaults()`: nearest-neighbor interpolation and categorical/discrete colormap behavior (no linear contrast windows; labels are categories, not intensities).
- `createDefaultLayers()`: segmentation-layer configs (one mask layer rather than per-channel additive image layers), wired to the label colormap and picking.
- Registration: a `"mask"` kind via `registerDataset`, self-registered from its own module exactly like `mesh` (core) or `image` (subpath) depending on its dependencies. No new registry, no changes to `Viewer`.

## Packaging / import-graph verification

- Core runtime dependencies: exactly `wgpu-matrix` (`dependencies`). `zarrita` is declared only as an optional `peerDependency` (`peerDependenciesMeta.zarrita.optional: true`) plus a devDependency for build/tests.
- `zarrita` is imported only by `src/dataset/ome-zarr.ts` and is external in the build. `dist/galavi.js` and `dist/index.d.ts` contain zero zarrita references; `dist/ome-zarr.js` imports it externally.
- `sideEffects` is `true` so the `"mesh"` self-registration (and consumer-side `import "galavi/ome-zarr"`) survive bundler tree-shaking.
- `scripts/check-pack.mjs` (`bun run test:pack`) asserts all of the above: tarball contents, exports map (`.` + `./ome-zarr`), dependency metadata, a zarrita-free core bundle, and that no source file other than `src/dataset/ome-zarr.ts` imports zarrita.

Future package boundary: if a third-party plugin ecosystem emerges, `galavi/ome-zarr` can move to a separate package such as `@galavi/ome-zarr` — the subpath boundary makes that migration mechanical (move `src/dataset/ome-zarr.ts`, import `Dataset`/`registerDataset` from `galavi`, keep `zarrita` as its own dependency).

## cerevi-web follow-up (not done — cerevi-web is untouched)

Current legacy API usage in cerevi-web (as of this refactor):

- `createGalavi({ state, views, theme })` and `type Galavi` — in `src/galavi/view-factories.ts`, `src/galavi/standalone-builders.ts`, `src/components/viewer/modes/GridMode.vue`, `src/composables/useGalaviSession.ts`, and mode components (`QuadrantMode.vue`, `SliceMode.vue`, `VolumeMode.vue`), plus theming/camera helpers.
- `@galavi/ome-zarr-adapter`: `openOMEZarr`, `fetch2DPlane`, `resolvedDatasetFromOMEZarr`, `getVolumeTransform`, `getPhysicalSpace` (`src/galavi/context.ts`, `src/galavi/slice-geometry.ts`).
- cerevi-web does **not** use `sourceRegistry`, `registerSource`, or `openDataset` directly.

Required migration (no galavi compatibility layer is or will be needed):

1. `createGalavi` → `createViewerEngine`, `Galavi` → `ViewerEngine`, config type → `ViewerEngineConfig`. The low-level composition API is 1:1 renamed.
2. `@galavi/ome-zarr-adapter` imports → `galavi/ome-zarr` (`openOMEZarr`, `fetch2DPlane`, `getVolumeTransform`, `getPhysicalSpace` all live there now). `resolvedDatasetFromOMEZarr(info, source)` is replaced by `ImageDataset` — construct via `openDataset({ type: "image", source: url })` and read `physical`/`channels`/`capabilities` off the instance. Add `zarrita` as a direct dependency of cerevi-web (it is an optional peer of galavi).
3. The adapter package `@galavi/ome-zarr-adapter` is superseded and will not track the new API.

### `specimens.json` runtime registration (future)

cerevi-web's `specimens.json` composition (per-specimen parallel `image` / `region_mask` / `mesh` variant maps, currently assembled imperatively in `buildSetupContext`) maps onto a custom dataset kind:

```ts
class SpecimenDataset extends Dataset {
  async load() { /* fetch specimens.json entry, open image variant, locate mesh/mask files */ }
  deriveDefaults() { /* per-mode defaults */ }
  createDefaultLayers() { /* image layers + surface layer for the mesh variant */ }
  dispose() { /* ... */ }
}
registerDataset("specimen", (config) => new SpecimenDataset(config));
```

This consumes `datasetRegistry` directly, lives entirely in cerevi-web, and requires no changes to galavi — that is the extension contract this refactor establishes.
