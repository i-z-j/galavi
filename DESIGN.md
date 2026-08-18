# Galavi API Design — Common Viewer vs Advanced Engine

Galavi exposes two deliberate API levels over one scene model. This document
defines what each level owns, how configuration flows between them, and which
concerns stay deliberately low-level. It records the design as implemented
(2026-08-17, the `review-0.md` Phase 1–5 convergence); the decision history
lives in `DX-AUDIT.md` (dated log, including the 2026-08-17 corrections
section) and `../review-0.md` (sections 7.1 and 9). Earlier revisions of this
document described the removed source-resolver architecture — those names are
gone from source, exports, and declarations, with no aliases.

## The two levels

```
galavi                          common entry
  createViewer(element, config)   common scientific viewer, sensible defaults
    └─ Viewer                     dataset, mode, channel, camera, tool, status, events
         └─ viewer.engine         explicit escape hatch to the live engine

galavi/advanced                 advanced entry (re-exports the common root)
  createViewerEngine(config)      advanced multi-view/layer/plugin scenes
    └─ ViewerEngine               state authority, shared runtime layers, GPU device
         └─ registries + base classes   plugin author surface

galavi/ome-zarr                 format entry (self-registers on import)
  "ome-zarr" dataset kind, openOMEZarrDataset, openOMEZarr, fetch2DPlane,
  plate helpers, ImageDataset, OMEZarrInfo
```

One conceptual model, two levels — the same terms throughout:

| Concept | Common API (`galavi`) | Advanced API (`galavi/advanced`) |
|---|---|---|
| Runtime owner | `Viewer` | `ViewerEngine` |
| Creation | `createViewer` | `createViewerEngine` |
| Source session | `Dataset` / `DatasetConfig` | Dataset-derived or explicit layer `Data` |
| Presentation | Dataset-supported Viewer mode | Explicit `ViewConfig` map |
| Appearance update | `viewer.channel/tool/...` | `updateLayers` / view overlay options |
| Escape hatch | `viewer.engine` | Engine itself |

The high-level `Viewer` is a facade *over* the engine, not a fork of it. Every
Viewer operation composes the same primitives an application could call
directly: `openDataset`, `createViewerEngine`, typed layer configs, the camera
fit helpers, and the control/overlay registries. Nothing in the scene model is
duplicated or bypassed, and the advanced API remains fully supported for scenes
the facade does not cover.

Normal `Viewer` use never exposes GPU device, canvas format, tile pool,
texture, buffer, shader, or render-pipeline concepts.

## Entry points and packaging

The package publishes three entries (`package.json` `exports`):

- **`galavi`** — the common root: `createViewer`, `Viewer`, the Viewer
  config/status/event types, `openDataset`, `Dataset`, `DatasetConfig`,
  `DatasetConfigMap`, `registerDataset`, `DatasetChannel`,
  `DatasetCapabilities`, common vector/physical types, the ROI event payload
  types, and the app-facing theme helpers.
- **`galavi/advanced`** — the low-level authoring surface: `createViewerEngine`,
  `ViewerEngine`, the raw scene model (`State`, `ViewConfig`, `LayerConfig`,
  `LayerPatch`), `updateLayers`, the registries and base + built-in
  layer/view/control/overlay classes, the typed per-layer/per-overlay option
  bags (including the callback-bearing overlay options), and the
  camera/projection/tile/plugin utilities. The common root is re-exported here
  so advanced consumers have one import site.
- **`galavi/ome-zarr`** — the OME-Zarr format loader. Importing it registers
  the `"ome-zarr"` dataset kind (its one intentional side effect) and exports
  `openOMEZarrDataset`, `openOMEZarr`, `fetch2DPlane`, the plate helpers
  (`openOMEZarrPlate`, …), `ImageDataset`, and `OMEZarrInfo`.

Packaging consequences, all enforced by `scripts/check-pack.mjs`:

- `zarrita` (the OME-Zarr store client) is a normal runtime dependency, so
  `npm install galavi` is sufficient — no companion adapter package.
- `sideEffects` is narrowed to the OME-Zarr entry (`./dist/ome-zarr.js`); the
  core and advanced entries are side-effect-free (the built-in `"mesh"` kind
  is a lazy registry built-in, not a module-load registration).
- The advanced entry is imported explicitly; the common root stays free of
  plugin internals so generated docs present the common API first.

## What the Viewer owns

A `Viewer` owns exactly one dataset session and everything a common scientific
viewer does with it:

- **Dataset session.** `createViewer(element, { dataset })` /
  `await viewer.open(config)` construct and load a fresh `Dataset` through
  `openDataset`. `await viewer.open(dataset)` adopts an already-loaded Dataset
  (ownership transfers — see below). Replacing the dataset is one awaited
  call; a superseded open rejects with `ViewerSupersededError` and never
  clobbers newer state.
- **Modes.** `viewer.mode` is `"auto" | "slice" | "volume" | "quad"`, with
  `await viewer.ready` for async completion. `mode: "auto"` resolves to the
  dataset's `capabilities.defaultMode`, exactly; `viewer.resolvedMode` and
  `viewer.availableModes` expose the outcome (capabilities intersected with
  what the target layout can host — a caller-owned canvas cannot host
  `"quad"`). Assigning an unavailable mode throws. Mode transitions destroy
  and recreate the underlying engine (view topology is construction-fixed)
  while preserving the physical focus — the camera target tracked from live
  state — and all channel intent.
- **Channel intent.** `viewer.channel(index).configure({ visible, color,
  contrast, label })` is the only channel API. The Viewer owns the internal
  layer-ID scheme (`<view>-c<index>`) and fans one channel operation out to
  every generated layer for that channel. Channel intent is keyed on channel
  index, so it survives mode transitions and dataset replacement.
- **Camera fit.** `camera: "fit"` / `viewer.fitCamera()` frame the dataset
  bounds via the same `frameVolumeCamera` / `fitSliceCamera` helpers the
  advanced entry exports; `viewer.setCamera(partial)` merges over the fit.
  `viewer.setSlicePoint(point)` pushes the slice containing a physical point
  into every slice layer of the current mode.
- **Controls and tools.** Declarative `controls` / `tools` config and the
  imperative `viewer.control(name)` / `viewer.tool(name)` handles share one
  normalization path and one typed option bag per name.
- **Loading state.** `viewer.status` / `viewer.error` expose
  `idle | loading | ready | error`; `viewer.ready` settles with the latest
  open/transition and rejects with its failure.
- **Runtime events.** `viewer.on("roiChange" | "roiActiveChange", handler)`
  subscribes to ROI tool activity and returns an unsubscribe function.
  Subscriptions live on the Viewer, so they survive open/mode rebuilds.
- **Declarative mirror.** `viewer.config` always reflects current intent —
  imperative changes are folded back into it — which is what keeps the
  config/imperative parity contract testable. The mirror is round-tripped
  through `JSON.parse(JSON.stringify(...))` on every read, proving the schema
  stays function-free.

## What stays advanced

The following are *not* forced through the Viewer schema. They remain
first-class on `createViewerEngine` from `galavi/advanced` (or through
`viewer.engine` when a Viewer is already running):

- **Multi-view composition.** Arbitrary `views` maps, explicit view IDs and
  canvas mounting, app-level layouts beyond the built-in modes (e.g. paged
  contact sheets, quadrant/grid arrangements with per-view cameras).
- **Custom layers and plugins.** Registered layer/view/control/overlay types,
  non-image layers (surface, shape, points, network, …), arbitrary layer
  ordering, custom shaders.
- **Explicit state serialization.** Direct `getState` / `setState` /
  `subscribe` workflows — saving, restoring, diffing, or syncing a raw scene
  `State` document.
- **Atomic multi-layer updates.** `engine.updateLayers(patches)` applies a
  batch as one transaction: every ID is validated before any mutation (an
  unknown ID throws and leaves state unchanged), and the result commits once —
  one subscriber notification, one scheduled render.
- **Callback-bearing overlay options.** `view.setOverlayOptions("roiselector",
  { onRoisChange })` and friends — runtime callbacks are a low-level feature
  (see Events below).
- **Renderer policy overrides.** Explicit `maxPoolSize`, custom fetch
  functions, and other tile-pipeline tuning. Explicit overrides always win
  over automatic policy.

`viewer.engine` is the supported escape hatch for one-off advanced operations
inside an otherwise high-level app (the examples use it for brain orientation
and bounded picking). It is replaced on every open/mode transition — never
cache it across those boundaries.

## The Dataset contract

A `Dataset` (`src/dataset/base.ts`) is one opened data source with normalized
metadata — the single dataset/source extension point:

- **Lifecycle.** `load()` performs source IO and populates the metadata
  fields; `dispose()` releases runtime resources held by the instance.
- **Normalized metadata.** `name?`, `physical?`, `channels`
  (`DatasetChannel[]`: render-ready `#RRGGBB` color, normalized clamped
  contrast window, initial visibility), `dimensions` + `defaultSelection` for
  non-spatial axes.
- **Capabilities.** `capabilities: DatasetCapabilities = { modes,
  defaultMode }` — the actual presentations the dataset can build layers for,
  and what `mode: "auto"` resolves to. Format-neutral by design: a dataset
  advertises real presentations, never image-pyramid facts (pyramid
  diagnostics stay on the format-specific subclass, e.g.
  `ImageDataset.pyramid`).
- **Default layer construction.** `createDefaultLayers(options)` builds the
  deterministic default `LayerConfig[]` for every advertised mode — one typed
  volume/slice layer per channel for image datasets, a surface layer for
  meshes.

Format-specific metadata stays on the format-specific subclass:
`ImageDataset` (`galavi/ome-zarr`) exposes the retained `OMEZarrInfo` via
`dataset.info`, so applications that need format metadata before scene
construction never pay a second store open.

### Registration and configs

Dataset kinds own an explicit, typed identity:

```ts
import { registerDataset, Dataset } from "galavi";

class MyDataset extends Dataset { /* load/dispose/createDefaultLayers */ }

declare module "galavi" {
  interface DatasetConfigMap {
    "my-kind": { type: "my-kind"; source: string /*, …*/ };
  }
}
registerDataset("my-kind", (config) => new MyDataset(config));
```

- `DatasetConfig` is the union of every registered loader's config, via
  `DatasetConfigMap` module augmentation. An unknown `type` key or a missing
  required field is a **compile error**, not a runtime surprise. External
  format packages augment `declare module "galavi"` (the root re-export);
  in-package kinds augment the same interface directly.
- The config stays pure JSON (`{ type, source, … }`) — runtime resources
  never appear in it. `ViewerConfig.dataset` therefore serializes.
- `registerDataset` re-registering an existing key **throws**, naming the
  conflicting key — a duplicate key means two loaders fighting over one
  identity.
- `openDataset(config)` dispatches through `datasetRegistry` and `load()`s a
  **fresh instance per call** — there is no caching layer; disposal is the
  caller's job (see Ownership). Unknown kinds reject with an actionable error
  listing the registered kinds and, for known out-of-core kinds, the import
  that provides them (`Unknown dataset kind: "ome-zarr" … Did you mean to
  import "galavi/ome-zarr"?`).
- Built-in kinds: `"mesh"` (always available through the core entry as a lazy
  registry built-in) and `"ome-zarr"` (registered by importing the
  `galavi/ome-zarr` subpath).

## Translation: ViewerConfig → State/ViewConfig

Given a `ViewerConfig`, the Viewer builds the engine scene deterministically:

| High-level | Low-level result |
|---|---|
| `dataset` | opened once via `openDataset` (or adopted); the loaded `Dataset` supplies `physical`, `channels`, `capabilities`, and the default layer configs |
| `State.physical` | populated from the dataset's physical space; channel labels promoted to `physical.channels.names` |
| `channels[n]` | dataset-generated typed volume/slice layers per channel, non-spatial selection written to the nested `options.selection.c` contract, visibility/color/contrast mapped to layer `render` |
| `mode` | view type, canvas binding, default control set (orbit for volume, panzoom for slice), and overlay set for that mode |
| `projection` | `render.volumeProjection` on volume layers (`"mip" | "minip" | "mean"`) |
| `camera` | fit helpers over the dataset bounds; `"fit"` is the default |
| `controls` / `tools` | typed control chains and built-in overlays (crosshair → `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier → `"magnifier-2d"`/`"magnifier-3d"`) via the registries |
| `modeOverrides[mode]` | applied when entering that mode — including an optional per-mode layer `transform` forwarded to each generated layer's `data.transform`; imperative equivalent `viewer.view(mode).configure(value)` |
| `theme` / `autoRotate` | forwarded to the generated `ViewerEngineConfig` / volume `ViewConfig` |

Every config key has an imperative equivalent with identical validation and
default merging; `ViewerConfig` is JSON-serializable by contract — no
callbacks, no runtime resources. Runtime event handlers, custom fetch
functions, and plugin instances are imperative concerns and never appear in
the schema.

## Runtime layer ownership and readiness

The engine owns one **shared runtime `BaseLayer` per state-layer ID** across
views (`ViewerEngine._runtimeLayers`, ARCH-1): views receive references from
that map, so a surface OBJ referenced by four views is fetched and parsed
once. Per-view GPU renderers (pipelines, tile pools, bind groups) remain per
view/layer pair — data runtime is shared, GPU residency is not.

Each runtime layer has **one tracked async load**, started once the GPU device
exists. Its settle fans out to every referencing view — readiness waiters
settle, per-layer GPU pipelines rebuild, one render is scheduled. A failure is
recorded on the layer (`loadStatus` / `loadError`, queryable via
`view.getLayerStatus(layerId)`) and **rejects** `view.whenLayerReady(layerId)`
with the recorded error instead of pending forever. Failures are surfaced,
never swallowed.

The high-level Viewer awaits the structural readiness of **every generated
layer** for the current mode (via each view that references it, so quad mode's
layers across four views are all covered) before `viewer.ready` /
`viewer.open()` settle — a surface-layer fetch/parse failure rejects them with
the recorded cause.

`MeshDataset` makes the same point at the dataset level: `load()` fetches and
parses the OBJ once, then hands the parsed geometry to its default surface
layer as pre-parsed `Data.geometry` — one network request and one parse per
open; the layer never fetches the URL itself.

## Dataset ownership rules

- **`openDataset(config)` → caller-owned.** Each call constructs and loads a
  fresh instance; the caller disposes it. (Same for `openOMEZarrDataset(url)`.)
- **`viewer.open(dataset)` → adoption.** Ownership transfers **at
  invocation**: after the call, only the Viewer disposes the instance — on
  supersession, replacement by a newer open, rebuild failure, and `destroy()`.
  Even if the returned promise rejects, the caller must not dispose it. (An
  invocation that itself *throws* — e.g. on a destroyed viewer — never
  transfers ownership.) Re-adopting the live dataset is a no-op for disposal.
- **`viewer.open(config)` / `createViewer(..., { dataset })`** — the Viewer
  opens through `openDataset` and owns the result under the same rules.

## Events and JSON-only tools

The high-level config surface is JSON-serializable intent (API-4):

- **Functions in tool options throw.** Passing a callback in `tools.*` (or the
  imperative equivalents) fails loudly with an actionable error naming the
  supported path — never silently dropped by the `viewer.config` JSON mirror.
- **Runtime ROI events are typed Viewer events:**
  `viewer.on("roiChange", handler)` delivers `{ rois, change, viewId, mode }`;
  `viewer.on("roiActiveChange", handler)` delivers `{ activeIndex, viewId,
  mode }`. Both return an unsubscribe function; one overlay change produces
  exactly one event; subscriptions survive open/mode rebuilds and are cleared
  on `destroy()`.
- **Callback-bearing overlay options stay low-level.** The low-level
  `view.setOverlayOptions("roiselector", { onRoisChange, onActiveIndexChange })`
  path remains in `galavi/advanced` (typed `RoiSelectorOverlayOptions`); the
  high-level `ViewerRoiOptions` type omits the callbacks by construction.

## Error semantics

- `viewer.open` rejects with the loader error **as-is** — `cause` chains are
  preserved, so unsupported-metadata vs network/CORS failures stay
  distinguishable (the OME-Zarr loader wraps store-open failures with the URL
  and keeps the original error as `cause`). Unknown dataset kinds reject with
  an actionable message listing the registered kinds plus the import hint.
- Low-level layers record load failures: `layer.loadStatus` /
  `layer.loadError`, `view.getLayerStatus(layerId)`, and `whenLayerReady`
  rejecting with the recorded error instead of pending forever. An abort
  settles only its own waiter; a pre-aborted signal wins over a recorded
  error.
- Superseded opens/transitions reject with `ViewerSupersededError`
  (last-write-wins via revision tokens); rapid mode flips skip intermediate
  application and settle on the final mode.
- Config validation is fail-fast with actionable messages (unknown channel
  index, malformed color, `"quad"` against a caller-owned canvas, functions in
  tool options, …).

## Metadata defaults policy

Values come from three tiers, in increasing precedence: **Galavi default →
dataset metadata → explicit config**. The rules that most often surprise:

- **Channels.** Count, labels, colors, contrast windows, and visibility come
  from OME/OMERO metadata when present (normalized once by the dataset's
  `load()` via `getChannelColor` / `buildContrastLimits`). Without metadata:
  one channel, `Channel N` labels, a tested fallback palette, contrast
  `[0, 1]`, first channel visible. Explicit `channels[n]` entries always win;
  curated scientific overrides belong in config, not in the library.
- **Physical space.** Spacing/origin/unit come from metadata; missing or
  incorrect metadata falls back to unitless normalized spacing and can be
  corrected explicitly. Anatomical orientation is never guessed from shape —
  it is an explicit transform decision owned by the application (the Viewer's
  per-mode `transform` override exists for exactly this).
- **Mode.** `mode: "auto"` resolves to the dataset's
  `capabilities.defaultMode`, exactly: 2D pyramids are slice-only; 3D image
  pyramids default to volume (every non-empty 3D pyramid advertises volume —
  the bounded-preview policy below keeps it renderable); meshes advertise
  volume only. `availableModes` intersects capabilities with target support.
- **Volume tile budgets.** The bounded-preview policy (`planVolumePreview`:
  384 slabs / 1296 tiles / 512² chunk texels / +64 pool headroom) applies
  automatically to volume layers with a `fetch`-based source and no explicit
  `maxPoolSize`. An explicit `maxPoolSize` disables the policy entirely —
  the override wins. Slice layers are never affected.
- **Projection, controls, tools, camera.** Defaults are `mip`, mode-appropriate
  controls, tools off (crosshair optional), and a fit camera. Deliberate
  scientific framing, per-mode contrast, and workflow-specific tools stay
  explicit in config.

## What stays application-owned

Galavi owns deterministic structural defaults: mode availability, fit camera,
metadata channels, basic controls, projection, and bounded volume policy.
Applications continue to own **curated contrast**, **anatomical orientation**
when metadata is absent, **selected scientific focus**, **workflow layout**,
and **domain UI**. Story-specific science does not move into generic helpers.

## Contract tests

The translation above is pinned by `tests/viewer.test.ts` (58 tests:
translation, status/failure/supersession, channel parity, projection,
transitions, overrides, controls/tools, camera, quad, serialization, escape
hatch/teardown), plus `tests/dataset.test.ts` and
`tests/dataset-config-types.test.ts` (registry dispatch, typed configs,
capabilities), `tests/shared-runtime-layers.test.ts` and
`tests/viewer-layer-readiness.test.ts` (ARCH-1 runtime sharing and readiness
rejection), `tests/viewer-adoption.test.ts` (ownership transfer),
`tests/viewer-roi-events.test.ts` and `tests/viewer-tools.test.ts` (API-4
events and JSON-only tools), `tests/api-surface.test.ts` (per-entry export
surface), and `tests/volume-tile-budget.test.ts` (budget policy).
