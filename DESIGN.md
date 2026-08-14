# Galavi API Design — High-Level Viewer vs Low-Level Scene API

Galavi exposes two API layers over one scene model. This document defines what
each layer owns, how configuration flows between them, and which concerns stay
deliberately low-level. It records the design as implemented (2026-08-11); the
normative proposal and decision history live in
`../engineering-cleanup-plan.md` (sections 15–16) and `DX-AUDIT.md`.

## The two layers

```
createViewer(element, config)     common scientific viewer, sensible defaults
  └─ Viewer                       dataset, mode, channel, camera, tool, status
       └─ viewer.galavi           explicit escape hatch to the live instance
            └─ createGalavi(config)   advanced multi-view/layer/plugin scenes
                 └─ registries + base classes   plugin author surface
```

The high-level `Viewer` is a facade *over* the low-level scene API, not a fork
of it. Every Viewer operation composes the same primitives an application
could call directly: `openDataset`, `createGalavi`, typed layer configs, the
camera fit helpers, and the control/overlay registries. Nothing in the scene
model is duplicated or bypassed, and the low-level API remains fully supported
for scenes the facade does not cover.

Normal `Viewer` use never exposes GPU device, canvas format, tile pool,
texture, buffer, shader, or render-pipeline concepts.

## What the Viewer owns

A `Viewer` owns exactly one dataset session and everything a common scientific
viewer does with it:

- **Dataset session.** `createViewer(element, config)` /
  `await viewer.open(source)` resolve the source once via `openDataset` and
  resolve with the `ResolvedDataset`. Replacing the dataset is one awaited
  call; a superseded open rejects with `ViewerSupersededError` and never
  clobbers newer state.
- **Modes.** `viewer.mode` is `"auto" | "slice" | "volume" | "quad"`, with
  `await viewer.ready` for async completion. `mode: "auto"` resolves
  deterministically from dataset capabilities; `viewer.resolvedMode` and
  `viewer.availableModes` expose the outcome. Mode transitions destroy and
  recreate the underlying Galavi (view topology is construction-fixed) while
  preserving the physical focus — the camera target tracked from live state —
  and all channel intent.
- **Channel intent.** `viewer.channel(index).configure({ visible, color,
  contrast, label })` is the only channel API. The Viewer owns the internal
  layer-ID scheme (`<view>-c<index>`) and fans one channel operation out to
  every typed layer for that channel. Channel intent is keyed on channel
  index, so it survives mode transitions and dataset replacement.
- **Camera fit.** `camera: "fit"` / `viewer.fitCamera()` frame the dataset
  bounds via the same `frameVolumeCamera` / `fitSliceCamera` helpers the
  low-level API exports; `viewer.setCamera(partial)` merges over the fit.
- **Controls and tools.** Declarative `controls` / `tools` config and the
  imperative `viewer.control(name)` / `viewer.tool(name)` handles share one
  normalization path and one typed option bag per name.
- **Loading state.** `viewer.status` / `viewer.error` expose
  `idle | loading | ready | error`; `viewer.ready` settles on completion.
- **Declarative mirror.** `viewer.config` always reflects current intent —
  imperative changes are folded back into it — which is what keeps the
  config/imperative parity contract testable.

## What stays low-level

The following are *not* forced through the Viewer schema. They remain
first-class on `createGalavi` (or through `viewer.galavi` when a Viewer is
already running):

- **Multi-view composition.** Arbitrary `views` maps, explicit view IDs and
  canvas mounting, app-level layouts beyond the built-in modes (e.g. paged
  contact sheets, quadrant/grid arrangements with per-view cameras).
- **Custom layers and plugins.** Registered layer/view/control/overlay types,
  non-image layers (surface, shape, points, network, …), arbitrary layer
  ordering, custom shaders.
- **Explicit state serialization.** Direct `getState` / `setState` /
  `subscribe` workflows — saving, restoring, diffing, or syncing a raw scene
  `State` document.
- **Renderer policy overrides.** Explicit `maxPoolSize`, custom fetch
  functions, and other tile-pipeline tuning. Explicit overrides always win
  over automatic policy.

`viewer.galavi` is the supported escape hatch for one-off advanced operations
inside an otherwise high-level app (the examples use it for brain orientation
and bounded picking). It is replaced on every open/mode transition — never
cache it across those boundaries.

## Translation: ViewerConfig → State/ViewConfig

Given a `ViewerConfig`, the Viewer builds the low-level scene deterministically:

| High-level | Low-level result |
|---|---|
| `source` | resolved once via `openDataset`; the `ResolvedDataset` supplies `pyramid`, `fetch`, `physical`, `channels`, `capabilities` |
| `State.physical` | populated from the dataset's physical space; channel labels promoted to `physical.channels.names` |
| `channels[n]` | one typed volume/slice layer per channel, non-spatial selection written to the nested `options.selection.c` contract, visibility/color/contrast mapped to layer `render` |
| `mode` | view type, canvas binding, default control set (orbit for volume, panzoom for slice), and overlay set for that mode |
| `projection` | `render.volumeProjection` on volume layers (`"mip" | "minip" | "mean"`) |
| `camera` | fit helpers over the dataset bounds; `"fit"` is the default |
| `controls` / `tools` | typed control chains and built-in overlays (crosshair → `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier → `"magnifier-2d"`/`"magnifier-3d"`) via the registries |
| `modeOverrides[mode]` | applied when entering that mode; imperative equivalent `viewer.view(mode).configure(value)` |

Every config key has an imperative equivalent with identical validation and
default merging (plan §15.4); `ViewerConfig` is JSON-serializable by contract —
no callbacks, no runtime resources. Runtime event handlers, custom fetch
functions, and plugin instances are imperative concerns and never appear in
the schema.

## Dataset resolution and caching

`openDataset(source)` dispatches on `source.type` through the dataset-resolver
registry (`registerDatasetResolver`, mirroring `registerSource`; adapter
registration entry points such as `registerOMEZarrSource()` register both).
Resolution is cached per source identity — `type` plus canonical `url`, with a
key-order-stable serialization fallback — including in-flight promises, so N
layers over one dataset share a single metadata open. Rejections are evicted
so retries work; `invalidateDataset(source)` / `invalidateAllDatasets()` drop
cached entries.

The low-level per-layer `data.source` path is untouched; the dataset resolver
layers over it.

## Error semantics

- `viewer.open` rejects with the resolver error **as-is** — `cause` chains are
  preserved, so unsupported-metadata vs network/CORS failures stay
  distinguishable. Unknown source types reject with an actionable message
  listing the registered resolvers.
- Low-level layers record source-resolution failures: `layer.loadStatus` /
  `layer.loadError`, `view.getLayerStatus(layerId)`, and `whenLayerReady`
  rejecting with the recorded error instead of pending forever. An abort
  settles only its own waiter; a pre-aborted signal wins over a recorded
  error.
- Superseded opens/transitions reject with `ViewerSupersededError`
  (last-write-wins via revision tokens); rapid mode flips skip intermediate
  application and settle on the final mode.
- Config validation is fail-fast with actionable messages (unknown channel
  index, malformed color, `"quad"` against a caller-owned canvas, …).

## Metadata defaults policy

Values come from three tiers, in increasing precedence: **Galavi default →
dataset metadata → explicit config**. The full policy table is plan §16; the
rules that most often surprise:

- **Channels.** Count, labels, colors, contrast windows, and visibility come
  from OME/OMERO metadata when present (normalized once by the resolver via
  `getChannelColor` / `buildContrastLimits`). Without metadata: one channel,
  `Channel N` labels, a tested fallback palette, contrast `[0, 1]`, first
  channel visible. Explicit `channels[n]` entries always win; curated
  scientific overrides belong in config, not in the library.
- **Physical space.** Spacing/origin/unit come from metadata; missing or
  incorrect metadata falls back to unitless normalized spacing and can be
  corrected explicitly. Anatomical orientation is never guessed from shape —
  it is an explicit transform decision owned by the application.
- **Mode.** `mode: "auto"`: z=1 → slice; z>1 → volume only when the dataset
  reports 3D support *and* the automatic tile-budget policy yields a valid
  bounded preview; otherwise slice, with volume still listed in
  `availableModes`.
- **Volume tile budgets.** The bounded-preview policy (`planVolumePreview`:
  384 slabs / 1296 tiles / 512² chunk texels / +64 pool headroom) applies
  automatically to volume layers with a `fetch`-based source and no explicit
  `maxPoolSize`. An explicit `maxPoolSize` disables the policy entirely —
  the override wins. Slice layers are never affected.
- **Projection, controls, tools, camera.** Defaults are `mip`, mode-appropriate
  controls, tools off (crosshair optional), and a fit camera. Deliberate
  scientific framing, per-mode contrast, and workflow-specific tools stay
  explicit in config.

## Contract tests

The translation above is pinned by `tests/viewer.test.ts` (40 tests:
translation, status/failure/supersession, channel parity, projection,
transitions, overrides, controls/tools, camera, quad, serialization, escape
hatch/teardown), plus `tests/dataset.test.ts` (resolver registry, caching,
capabilities) and `tests/volume-tile-budget.test.ts` (budget policy).
