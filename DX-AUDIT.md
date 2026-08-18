# Galavi DX Audit — Living Decision Record

**Purpose:** this document is the living decision record governing all galavi public-API DX decisions. It is linked from the galavi-examples implementation and records the DX issues identified in the 2026-08-11 engineering audit (`../engineering-cleanup-plan.md`, sections 13–16), their current status, and the rationale for accepted or rejected changes. Update it as decisions land; do not rewrite history — append to the decision log.

**Audit date:** 2026-08-11

**Status legend:** `proposed` / `accepted` / `rejected` / `implemented` / `partially implemented` / `deferred`. Rejected proposals must be preserved with rationale so example workarounds do not reappear later (see Decision Log).

**Ranking:** frequency, then severity, then first-time impact, then implementation complexity. Q = quick API/consumer improvement, M = medium improvement, L = larger architectural change, H = hygiene.

**Verified mechanisms referenced below:**
- Galavi image layers read non-spatial dimension selection **only** from the nested `options.selection` object (`galavi/src/layer/tiled-image.ts`, `applyOptions` in `galavi/src/layer/base.ts`). Unknown top-level option keys are silently ignored per the config-boundary policy in `galavi/src/types.ts`; the OME-Zarr adapter falls back to index 0 for each unselected non-spatial axis (`galavi-ome-zarr-adapter/src/fetch2d.ts`).
- `options.maxPoolSize` is a legitimately consumed `TiledImageOptions` key (`galavi/src/layer/tiled-image.ts`).
- `galavi.setTarget` recomputes the camera position for orbit cameras but does **not** preserve/reposition slice/fly cameras (verified during the 2026-08-11 pass).
- Galavi core `State` has no layout mode (only `physical`, `layers`, `exploration`); core view types are only `volume` and `slice`. Application modes `volume|slice|quad|grid` are app-level concepts; the former collision with low-level `render.mode` is resolved — the field is now `render.volumeProjection` (DX-Q5, implemented 2026-08-11).
- `getPhysicalSpace` is exported from `@galavi/ome-zarr-adapter`, not galavi core.

---

## Quick API and consumer improvements

### DX-Q1: Typed image-layer configuration and selection diagnostics

- **Status:** implemented
- **Affected:** Astrocytes, Plate, Brain contact sheet, any multichannel Open source; broad `LayerConfig` use across examples. Examples: `galavi-examples/src/viewer/image-layers.ts`, `src/viewer/session.ts`, `src/viewer/modes/contact-sheet.ts`. Cerevi: `cerevi-project/cerevi-web/src/galavi/layer-factories.ts`.
- **Current usage:** `{ options: { ...defaultSelection, c: channel } }` compiles but is ignored: volume/slice layers read only `options.selection`, so the adapter silently serves channel 0 for every layer while UI colors still change.
- **Pain:** silent scientific correctness failure — the worst defect class for a microscopy viewer.
- **Frequency:** every generated image layer. **Severity:** critical. **Complexity:** low.
- **First-time impact:** a first-time developer copying the obvious `{ c: channel }` shape gets a silently wrong multichannel image.
- **Owning package:** galavi (core diagnostics) + galavi-examples (consumer fix).
- **Proposed improvement:** typed layer config aliases / exported discriminated `AnyLayerConfig`; galavi dev-time rejection or warning on unknown built-in option keys; document `selection` as the only non-spatial dimension path.
- **Expected application-code reduction:** little LOC reduction, but removes all selection casts and prevents a high-severity silent defect.
- **Landed (2026-08-11, examples side):** galavi-examples now uses typed `VolumeLayerConfig` / `SliceLayerConfig` factories in `src/viewer/image-layers.ts` that write the nested `options.selection.c`, with regression tests (`src/viewer/image-layers.test.ts`).
- **Landed (2026-08-11, core side):** galavi warns (development-only, never throws) when a built-in tiled image layer receives option keys it does not recognize — at construction and on the `setOptions` path (`TiledImageLayer` in `galavi/src/layer/tiled-image.ts`, `SliceLayer` key list in `galavi/src/layer/slice/main.ts`). The warning names the layer id and stray keys and points at `options.selection`. Gating: `import.meta.env?.DEV !== false`; vite's production build statically replaces it and rollup tree-shakes the branch (verified: no warning code in `dist/galavi.js`). The `TiledImageOptions.selection` doc comment now warns against top-level dimension keys. Tests: `galavi/tests/dev-option-warnings.test.ts`.

```ts
// Before
const options = { ...info.defaultSelection, c: channel };

// After
const options: VolumeOptions = {
  selection: { ...info.defaultSelection, c: channel },
};
```

- **Dependencies:** none for the consumer fix; dev-time key checking lives in core `applyOptions`.
- **Migration impact:** none — the core diagnostic is a non-breaking development-mode warning; unknown keys remain ignored at runtime.
- **Tests:** `galavi-examples/src/viewer/image-layers.test.ts` covers nested selection; `galavi/tests/dev-option-warnings.test.ts` covers the core warning (construction + `setOptions` path, warn/no-warn).
- **Owner decision:** accepted (warning, not rejection — rejection would be breaking). Implemented 2026-08-11.

### DX-Q2: Use existing camera convenience API

- **Status:** implemented (examples)
- **Affected:** Brain slice stepping and picking. Examples: `galavi-examples/src/viewer/index.ts`. Cerevi: n/a (own camera math retained).
- **Current usage (pre-fix):** clone camera, compute offset, replace full state via `getState`/`setState` with an `as any` cast.
- **Pain:** reimplements `galavi.setTarget`, repeats `getState`, and uses `as any`.
- **Frequency:** two workflow paths. **Severity:** medium. **Complexity:** trivial.
- **First-time impact:** teaches new developers the wrong pattern for the most common camera operation.
- **Owning package:** galavi-examples only; **no core change needed**.
- **Proposed improvement:** replace the local helper with `galavi.setTarget(target)`; feature it in developer content.
- **Expected application-code reduction:** ~9–12 lines and one full-state mutation helper.
- **Landed (2026-08-11):** galavi-examples delegates orbit-camera targeting to `galavi.setTarget` (`src/viewer/index.ts:502-513`). Verified caveat: `setTarget` does not preserve slice/fly camera position, so those cameras keep the typed `getState`/`setState` path.

```ts
// Before
const state = galavi.getState();
const camera = { ...state.exploration.camera, target, position: translatedPosition };
galavi.setState({ ...state, exploration: { ...state.exploration, camera } });

// After
galavi.setTarget(target);
```

- **Dependencies:** none. **Migration impact:** none.
- **Tests:** covered by existing example tests (`src/viewer/session.test.ts`).
- **Owner decision:** accepted (examples-side; closed).

### DX-Q3: Reuse public channel helpers

- **Status:** implemented (examples)
- **Affected:** all five stories and Open metadata normalization. Examples: `galavi-examples/src/viewer/session.ts`. Cerevi: already uses these helpers.
- **Current usage (pre-fix):** manual color prefixing, a `[0, 0.06]` fallback, and repeated metadata array indexing.
- **Pain:** inconsistent defaults; examples duplicated tested utilities Cerevi already relied on.
- **Frequency:** every dataset open and render update. **Severity:** medium. **Complexity:** low.
- **First-time impact:** examples contradicted the library's own documented helpers.
- **Owning package:** galavi-examples only.
- **Proposed improvement:** use `getChannelColor`, `buildContrastLimits`, and `clampContrastLimits`; keep curated story overrides explicit and applied last.
- **Expected application-code reduction:** ~10–15 lines in metadata setup plus repeated color-normalization branches.
- **Landed (2026-08-11):** `src/viewer/session.ts` normalization uses all three helpers; curated per-story seeds are applied explicitly after normalization.

```ts
// Before
color: info.omeroChannelColors?.[i] ?? "FFFFFF",
contrast: info.omeroChannelContrastLimits?.[i] ?? [0, 0.06],

// After
color: getChannelColor(i, info.omeroChannelColors?.[i]),
contrast: buildContrastLimits(info.omeroChannelContrastLimits, count)[i],
```

- **Dependencies:** none. **Migration impact:** none.
- **Tests:** `src/viewer/session.test.ts`.
- **Owner decision:** accepted (examples-side; closed).

### DX-Q4: Typed overlay options

- **Status:** implemented
- **Affected:** example toolbox and Cerevi `syncViewOverlays`; dozens of calls. Examples: `galavi-examples/src/viewer/panels.ts`. Cerevi: `cerevi-project/cerevi-web/src/composables/useGalaviSession.ts`, mode components.
- **Current usage:** `setOverlayOptions(type: string, Record<string, unknown>)` and untyped `ViewConfig.overlays`.
- **Pain:** misspelled visibility/callback/position keys compile; option types exist only partially, so UI defects surface only at runtime.
- **Frequency:** high. **Severity:** medium. **Complexity:** low to medium.
- **First-time impact:** typos in overlay keys are invisible until manual UI testing.
- **Owning package:** galavi.
- **Proposed improvement:** export an `OverlayOptionsMap`, type built-in keys with a custom-string escape for plugins, and overload `setOverlayOptions`.
- **Expected application-code reduction:** minimal LOC; removes casts and converts runtime UI defects into compile errors.

```ts
// Before: typo compiles
view.setOverlayOptions("crosshair", { visibile: true });

// After: compile error, typed position
view.setOverlayOptions("crosshair", { visible: true, position });
```

- **Dependencies:** none. **Migration impact:** breaking for call sites that pass mistyped keys (intended); plugin overlays keep the string escape.
- **Landed (2026-08-11):** `OverlayOptionsMap` plus per-overlay option bags exported from the galavi entry (`galavi/src/overlay/options.ts`); `ViewAccessor.setOverlayOptions` types built-in type strings via a generic conditional (`K extends keyof OverlayOptionsMap ? Partial<OverlayOptionsMap[K]> : Record<string, unknown>` — plain overloads would let typos fall through to the string escape hatch) and `ViewConfig.overlays` is typed the same way, mirroring the `ControlOptions` pattern. Both galavi-examples and cerevi-web typecheck unchanged — no newly exposed consumer type errors.
- **Tests:** `galavi/tests/overlay-options.test.ts` — `@ts-expect-error` assertions (misspelled key, wrong value type, `ViewConfig.overlays` typo) plus a runtime pass-through test for custom overlay types.
- **Owner decision:** accepted. Implemented 2026-08-11.

### DX-Q5: Unambiguous mode/projection naming

- **Status:** implemented (2026-08-11)
- **Affected:** all volume stories; any high-level `Viewer` schema. Examples: `galavi-examples/src/viewer/state.ts`, `src/stories/brain.ts`. Cerevi: mode components and stores.
- **Current usage:** application viewer mode is `volume|slice|quad|grid` (app-level; galavi core `State` has no layout mode — verified 2026-08-11); volume accumulation is low-level `render.volumeProjection` (`"mip" | "minip" | "mean"`).
- **Pain:** a high-level config needs `mode` for visualization mode, making `mode` on a channel layer ambiguous.
- **Frequency:** every volume config/UI. **Severity:** low to medium. **Complexity:** low but breaking.
- **First-time impact:** two meanings of `mode` in one config block is a persistent stumbling block.
- **Owning package:** galavi.
- **Proposed improvement:** `Viewer.mode` for visualization/layout, `projection` (or `volumeProjection`) for MIP/MinIP/Mean. If low-level `Render.mode` is renamed, do it once without an alias and migrate all consumers.
- **Expected application-code reduction:** none; improves readability and schema stability.

```ts
// Before
layer.setRender({ mode: "mip" });

// After
viewer.projection = "mip";
```

- **Dependencies:** couples to DX-L1 schema. **Migration impact:** breaking rename across galavi-examples and cerevi-web if `Render.mode` is renamed.
- **Tests:** schema parity tests in `galavi/tests`.
- **Owner decision:** approved (2026-08-11, superseding the earlier deferral) — rename once, no alias, migrate all consumers. **Implemented 2026-08-11:** low-level `render.mode` renamed to `render.volumeProjection` across galavi core, galavi-examples, cerevi-web, galavi-docs, and READMEs, with no compatibility alias; `galavi/tests/volume-mode.test.ts` asserts the old `render.mode` key is ignored. The high-level `Viewer.projection` schema remains part of the Track B pass.

---

## Medium improvements

### DX-M1: Dataset-scoped metadata resolution

- **Status:** implemented (2026-08-11)
- **Affected:** every example and Cerevi setup. Examples: `galavi-examples/src/viewer/session.ts`, `src/stories/*.ts`. Cerevi: `cerevi-project/cerevi-web/src/galavi/context.ts`.
- **Current usage:** `openOMEZarr`, `getPhysicalSpace` (adapter export — corrected 2026-08-11), channel extraction, camera fit, and layer construction are separate app steps.
- **Pain:** `Data.source` resolves render artifacts per layer but never produces a viewer-ready dataset; its `physical` hint is not promoted into state and channels are absent.
- **Frequency:** once per dataset and again per source variant. **Severity:** high. **Complexity:** medium, across core and adapters.
- **First-time impact:** the simplest "open a dataset" task requires understanding four separate APIs.
- **Owning package:** galavi + galavi-ome-zarr-adapter.
- **Proposed improvement:** a format-neutral resolved-dataset contract (source runtime, physical space, dimensions/selections, normalized channels, dtype, capabilities), resolved once per dataset session and shared across layers.
- **Expected application-code reduction:** 20–50 lines per app open path; eliminates repeated metadata opens.

```ts
// Before
const info = await openOMEZarr(url);
const physical = getPhysicalSpace(info);
const channels = normalizeChannels(info);
const camera = frameVolumeCamera(physical);

// After
const dataset = await openDataset({ type: "ome-zarr", url });
```

- **Landed (2026-08-11):**
  - Core (`galavi/src/dataset.ts`, exported from the galavi entry): the format-neutral `ResolvedDataset` contract — `source` (canonical descriptor), `name?`, `pyramid` + `fetch` (the same runtime artifacts `Data.pyramid`/`Data.fetch` consume, so today's layer configs derive directly), `physical`, `dimensions` + `defaultSelection`, normalized `channels` (`index`, `label`, `#RRGGBB` `color`, clamped `contrast`, `visible`), `dtype`, and `capabilities` (`zDepth`, `supports3D`, `supportsVolumePreview`). `getDatasetCapabilities(pyramid)` derives capabilities with DX-M4 `planVolumePreview` semantics, so `mode: "auto"` can ask "can volume produce a valid bounded preview" without a renderer. Zero OME-Zarr concepts in the contract. Everything except `fetch` is plain JSON; `fetch` is the documented imperative runtime field, with `source` as the canonical serializable form.
  - Resolver registry mirroring `registerSource`: `registerDatasetResolver(type, resolver)`, `datasetResolverRegistry`, and `openDataset(source: SourceDescriptor): Promise<ResolvedDataset>`. Resolution happens once per source identity — `datasetCacheKey(source)` is `type` + canonical `url`, falling back to key-order-stable descriptor serialization — and the in-flight promise is cached, so N layers over one dataset share a single metadata open. Rejections are evicted (retries work); `invalidateDataset(source)` / `invalidateAllDatasets()` drop cached entries. Unknown types reject with an actionable message listing registered resolvers; resolver errors reject as-is (never swallowed).
  - Adapter (`galavi-ome-zarr-adapter/src/dataset.ts`): `registerOMEZarrSource()` — the one public registration entry — now also registers the `"ome-zarr"` dataset resolver. `resolveOMEZarrDataset` wraps open failures with the URL and preserves the original error as `cause` (unsupported metadata vs network/CORS stay distinguishable); `resolvedDatasetFromOMEZarr(info, source)` is exported for apps that already hold an open store. Channel normalization follows the §16 policy table via galavi's `getChannelColor`/`buildContrastLimits`: count from the `c` axis (else omero count, else 1), labels `Channel N` by default, contrast default `[0, 1]`, visibility from omero `active` flags else first channel only.
  - The low-level per-layer `Data.source` path is untouched.
- **Dependencies:** adapter normalized-metadata work (DX-M5 shares the adapter surface); feeds DX-L1.
- **Migration impact:** additive for the new contract; Cerevi `context.ts` adopts it where it removes duplicate OME-Zarr setup, retaining specimen metadata and anatomical orientation locally.
- **Tests:** `galavi/tests/dataset.test.ts` (13 tests: registry dispatch, unknown-type/descriptor errors, sequential+concurrent caching, identity fallback serialization, invalidation, rejection eviction, 2D/3D/z-chunk=1/empty capabilities); `galavi-ome-zarr-adapter/tests/dataset.test.ts` (7 tests: stubbed-fetch 3D multichannel and 2D stores, caching/invalidation through `openDataset`, unsupported-metadata and missing-url errors, synthetic-fixture default channels and z-chunk=1 bounded-preview capability).
- **Owner decision:** accepted. Implemented 2026-08-11.

### DX-M2: Rejectable loading/error state

- **Status:** implemented (2026-08-11, low-level readiness path + high-level `viewer.open` with DX-L1)
- **Affected:** all source-backed examples and generic Open. Examples: `galavi-examples/src/viewer/index.ts`, `src/viewer/session.ts`. Cerevi: `useGalaviSession.ts`.
- **Current usage:** source-registry failures log to console and leave a layer not-ready; `whenLayerReady` can remain pending until abort/destroy. Examples pre-open metadata to get actionable errors.
- **Pain:** first-time developers cannot distinguish loading, unsupported metadata, CORS, network failure, and a blank renderer.
- **Frequency:** every failed open. **Severity:** high. **Complexity:** medium.
- **First-time impact:** a failed open looks like a blank canvas with a console line — the most common first-run dead end.
- **Owning package:** galavi.
- **Proposed improvement:** `viewer.open` rejects on metadata/source failure and exposes `idle|loading|ready|error`; low-level readiness gains a failure channel or settled source result.
- **Expected application-code reduction:** ~15–25 lines of per-app loading/error orchestration and no indefinite waits.

```ts
// Before
registerOMEZarrSource();
const galavi = await createGalavi(config);
await galavi.view("main").whenLayerReady("volume", { signal });

// After (low-level, landed 2026-08-11)
await galavi.view("main").whenLayerReady("volume", { signal }); // rejects with the recorded load error
galavi.view("main").getLayerStatus("volume"); // { status: "idle" | "loading" | "ready" | "error", error? }

// After (high-level viewer.open) — pending with DX-L1
await viewer.open(source); // resolves ready, rejects with actionable cause
```

- **Landed (2026-08-11):**
  - Load-state channel on the layer (`galavi/src/layer/base.ts`): `LayerLoadStatus` (`"idle" | "loading" | "ready" | "error"`), `LayerLoadState` (`{ status, error? }`), and `BaseLayer.loadStatus` / `BaseLayer.loadError` getters. The `BaseLayer` default derives from `isReady` (`ready`/`loading`); `TiledImageLayer` overrides to report `idle` (no source), `loading` (descriptor resolution in flight), `ready`, and `error` (recorded failure). `isReady` is unchanged — non-failing layers behave identically.
  - Failure recording (`galavi/src/layer/tiled-image.ts`): a source-descriptor resolution failure is recorded on the layer, logged as before, and signaled through the existing render-request channel. Registry misses record an actionable error naming the layer and the registered source types (`Unknown source type: "x" for layer "v" (registered: …)`, with the registry's `Unknown type` error as `cause`) — mirroring `openDataset`'s unknown-type rejection. Factory/adapter rejections are recorded **as-is** (never wrapped), matching `openDataset`'s "resolver errors reject as-is" policy, so the same failure — including the adapter's URL context and `cause` chain distinguishing unsupported metadata from network/CORS — surfaces identically on the per-layer path and the `openDataset` path. Setting a new source clears the recorded error and retries.
  - Rejection (`galavi/src/view/base.ts`): `whenLayerReady` rejects with the recorded load error — pending waiters reject when the failure is signaled; calls made while `loadStatus` is `"error"` reject immediately. Precedence: an abort settles only its own waiter, so an aborted waiter never sees a late failure (abort wins); a call with an already-aborted signal rejects with the abort reason even when the layer is already in error (abort checked first). Removal/destroy rejection semantics unchanged.
  - Status query: `BaseView.getLayerStatus(layerId)` and `galavi.view(id).getLayerStatus(layerId)` return `LayerLoadState | undefined` (undefined for unknown IDs) — a poll-based counterpart of `whenLayerReady`, no subscription needed. The `subscribe` state channel stays pure JSON; load state is runtime-only, like resolved source artifacts.
  - Public surface: `LayerLoadStatus`, `LayerLoadState` types and the `BaseLayer` getters exported from the galavi entry; `getLayerStatus` on `ViewAccessor`.
  - The high-level `viewer.open` half of the proposal landed with DX-L1 (2026-08-11): `viewer.open` resolves ready / rejects with the resolver cause, and `viewer.status`/`viewer.error` expose idle/loading/ready/error. The examples/Cerevi pre-open workaround is retained until the consumer migration pass.
- **Dependencies:** DX-M1 resolver provides the rejection point. **Migration impact:** additive state channel; existing readiness APIs retained.
- **Tests:** `galavi/tests/source-registry.test.ts` (new "source failure channel (DX-M2)" block: rejecting factory → `whenLayerReady` rejects with the original error and preserved `cause`; registry-miss error names registered types and keeps the registry error as `cause`; abort wins over a late failure; pre-aborted signal wins over a recorded error; `idle → loading → ready` transitions; new source clears the error and retries; sibling layers unaffected) and `galavi/tests/layer-readiness.test.ts` (default `loadStatus` tracks readiness). No pre-existing test expectations changed.
- **Owner decision:** accepted. Implemented 2026-08-11 (low-level path; `viewer.open` deferred to DX-L1).

### DX-M3: Public channel model instead of layer-ID grouping

- **Status:** implemented (2026-08-11, with DX-L1)
- **Affected:** Astrocytes, Plate, Brain grid, Open, and all four Cerevi modes. Examples: `galavi-examples/src/viewer/image-layers.ts`, `src/viewer/panels.ts`. Cerevi: mode components `VolumeMode/SliceMode/QuadrantMode/GridMode.vue`.
- **Current usage:** one layer per channel, IDs such as `vol-c2` or `sliceXY:c2`; scans or specific lists to update render and selection.
- **Pain:** internal rendering structure leaks into application state and UI; adding a channel takes much more than three lines.
- **Frequency:** high in every multichannel interaction. **Severity:** high. **Complexity:** medium.
- **First-time impact:** developers must learn the ID-suffix convention to do the most common scientific operation.
- **Owning package:** galavi.
- **Proposed improvement:** a viewer-level channel collection/group maps channel state to underlying layers; keep low-level layer access for advanced scenes.
- **Expected application-code reduction:** 15–60 lines per multichannel view; removes string-suffix conventions from UI.

```ts
// Before
for (const layer of galavi.getState().layers) {
  if (layer.id.endsWith(`-c${index}`)) galavi.layer(layer.id)?.setRender(update);
}

// After
viewer.channel(index).configure({ visible, color, contrast });
```

- **Dependencies:** DX-L1 facade hosts the channel collection. **Migration impact:** additive; low-level layer APIs unchanged.
- **Tests:** channel-to-layer mapping tests in `galavi/tests`.
- **Landed (2026-08-11, with DX-L1):** `viewer.channel(index)` returns a typed handle — `configure({ visible?, color?, contrast?, label? })` and a `config` snapshot — hosted by the `Viewer` facade (`galavi/src/viewer/`). The Viewer owns the layer-ID scheme (`<view>-c<index>`, e.g. `volume-c1`, `quad-xy-c0`): one typed volume/slice layer per channel with nested `options.selection.c`, so no application ever scans layer IDs. `configure` shares one normalization/validation path with the declarative `channels[n]` key (color → `#RRGGBB`, contrast clamped ordered into [0,1]) and applies live via `galavi.layer(id).setRender(...)` across every internal layer for that channel; channel intent survives mode transitions and dataset replacement (overrides key on channel index). `viewer.channels` exposes the effective collection. Tests: `galavi/tests/viewer.test.ts` ("channel model" block — config/imperative parity, multi-layer mapping, label promotion to `physical.channels.names`, actionable index/color validation).
- **Owner decision:** accepted. Implemented 2026-08-11 (hosted by the DX-L1 facade, as proposed).

### DX-M4: Automatic volume tile-budget policy

- **Status:** implemented (2026-08-11)
- **Affected:** Brain and Astrocytes (both z-chunk=1 OME-Zarr stores).
- **Current usage:** example-local z-strided virtual pyramid plus `maxPoolSize` calculations and hardcoded tile/slab/texel budgets.
- **Pain:** a normal volume example must understand storage chunks and GPU residency to render a valid OME-Zarr store.
- **Frequency:** two flagship 3D datasets; likely common for z-chunk=1 microscopy. **Severity:** high. **Complexity:** medium to high.
- **First-time impact:** volume rendering "doesn't work" out of the box for the most common microscopy chunking.
- **Owning package:** galavi (volume tile planner). The adapter remains format normalization, not renderer policy.
- **Proposed improvement:** move budget-aware level/sampling policy into galavi's volume tile planner using existing pyramid/chunk metadata.
- **Expected application-code reduction:** ~70 lines and all common-path pool sizing from examples.

```ts
// Before
const source = makeVolumeSource(info);
options.maxPoolSize = source.maxTiles + 64;

// After
await viewer.open(source); // planner selects a bounded valid preview automatically
```

- **Verified note (2026-08-11):** the workaround (`makeVolumeSource` z-strided virtual pyramid + `maxPoolSize = maxTiles + 64`) now lives in `galavi-examples/src/stories/brain.ts` and is applied by the viewer to **all** volume datasets, not just brain. `maxPoolSize` **is** a legitimately consumed `TiledImageOptions` key (`galavi/src/layer/tiled-image.ts`) — the leak is budget policy, not a dead option.
- **Landed (2026-08-11):** the policy moved into galavi core unchanged in substance:
  - `galavi/src/utils/tile/volume-policy.ts` exports `planVolumePreview(pyramid)` plus the budget constants (`VOLUME_PREVIEW_MAX_SLABS=384`, `VOLUME_PREVIEW_MAX_TILES=1296`, `VOLUME_PREVIEW_MAX_CHUNK_TEXELS=512²`, `VOLUME_PREVIEW_POOL_HEADROOM=64`). It returns `null` for well-behaved pyramids; otherwise the same z-strided virtual pyramid + fetch remap + `maxTiles` the example workaround computed. The budgets are policy constants, not GPU-derived — the `TilePool` still clamps the final allocation to device limits, so core can own them.
  - `TiledImageLayer.effectiveSource` gained a memoized policy hook (`applyEffectiveSourcePolicy`, identity by default); `VolumeLayer` overrides it to apply the preview plan, and `VolumeLayer.getTileSpec` sizes the pool to `maxTiles + VOLUME_PREVIEW_POOL_HEADROOM`. Activation requires a `fetch` function (needed to remap strided z coordinates) and NO explicit `maxPoolSize` — the explicit override still wins and disables the policy entirely. Slice layers never get the policy (slice planes read the full pyramid, as before). urlTemplate-only sources cannot be strided and pass through untouched (documented limitation; adapters all provide `fetch`).
  - Examples: `makeVolumeSource`, `VolumeSource`, the budget constants, and the `wrapVolumeSource` session hook are deleted; `buildSessionLayers` hands volume layers the plain `info.pyramid`/`info.fetchTile` pair with no `maxPoolSize`. Nothing had to stay local: brain picking and the contact sheet always read the full unwrapped pyramid (`info.pyramid` directly), so the strided preview — which only the volume display path sees — affects neither.
- **Dependencies:** DX-M1 capability metadata informs the planner. **Migration impact:** the example workaround is deleted once the planner lands; low-level `maxPoolSize` override retained.
- **Tests:** `galavi/tests/volume-tile-budget.test.ts` — synthetic brain (1937 slabs, 256×256 chunks) and astrocytes (1402 slabs/level) fixtures prove slab/tile/texel bounds, fetch remapping, explicit-override precedence, well-behaved/chameleon and shallow z-chunk=1 pyramids untouched, urlTemplate pass-through, and slice-layer immunity. Examples: `galavi-examples/src/viewer/session.test.ts` asserts volume layers get the plain pyramid/fetch pair with no `maxPoolSize`.
- **Owner decision:** accepted. Implemented 2026-08-11.

### DX-M5: Typed OME high-content-screen metadata

- **Status:** implemented (adapter side, 2026-08-11); galavi-examples migration pending the examples pass.
- **Affected:** Plate story only, but it is a key scientific workflow. Examples: `galavi-examples/src/stories/plate.ts`.
- **Current usage:** direct `zarrita.open.v3`, `unknown as FetchStore`, `attrs as any`.
- **Pain:** format details and unsafe schema parsing leak into the example; field counts can drift from metadata.
- **Frequency:** one story. **Severity:** medium. **Complexity:** medium in the OME-Zarr adapter.
- **First-time impact:** anyone reproducing an HCS example must learn zarrita internals.
- **Owning package:** galavi-ome-zarr-adapter.
- **Proposed improvement:** adapter-level typed `openOMEZarrPlate` / dataset-hierarchy result with rows, columns, wells, images/fields, and child source descriptors.
- **Expected application-code reduction:** ~40–60 lines, removes direct `zarrita` from examples, fixes field correctness.

```ts
// Before
const group = await zarr.open.v3(store, { kind: "group" });
const plate = (group.attrs as any).ome.plate;

// After
const plate = await openOMEZarrPlate(source);
```

- **Verified note (2026-08-11):** plate parsing is now isolated in `galavi-examples/src/stories/plate.ts`; field counts are derived from OME `well.images` metadata when present (the 32-field loop remains only as a fallback). The direct `zarrita` dependency and the `attrs as any` cast remain until the adapter ships a typed HCS API.
- **Dependencies:** shares the adapter normalized-metadata surface with DX-M1. **Migration impact:** additive adapter export; example deletes local parsing.
- **Tests:** HCS fixture tests in the adapter test suite (`galavi-ome-zarr-adapter/tests/plate.test.ts`, v0.4 + v0.5 fixtures, landed 2026-08-11).
- **Owner decision:** approved (2026-08-11) — shipped as `openOMEZarrPlate(url, options?)` in `galavi-ome-zarr-adapter/src/plate.ts`, returning typed `OMEZarrPlateInfo` (rows, columns, wells, fields with ready-to-use per-field `SourceDescriptor`s; v0.4 and v0.5 attrs; actionable not-a-plate/missing-metadata errors; no `any` at the boundary). Examples keep their isolated local parser until the examples migration pass adopts this.

### DX-M6: Runtime parity for controls and tools

- **Status:** implemented (2026-08-11, with DX-L1)
- **Affected:** example toolbox and Cerevi mode/tool synchronization. Examples: `galavi-examples/src/viewer/panels.ts`. Cerevi: `useGalaviSession.ts`.
- **Current usage:** controls are creation-only; overlays are runtime-updatable but untyped and not grouped as user-facing tools.
- **Pain:** declarative config cannot map cleanly to imperative runtime updates for all requested keys (breaks the one-to-one mapping policy).
- **Frequency:** moderate. **Severity:** medium. **Complexity:** medium.
- **First-time impact:** enabling a tool at runtime uses a different mental model than at creation.
- **Owning package:** galavi.
- **Proposed improvement:** `viewer.control(name).configure/enable` and `viewer.tool(name).configure/enable`, backed by typed built-ins; config keys invoke the same operations.
- **Expected application-code reduction:** 10–30 lines of tool gating per simple app; Cerevi may retain domain-specific gating.

```ts
// Before
view.setOverlayOptions("ruler", { visible: enabled, unit });

// After
viewer.tool("ruler").configure({ enabled, unit });
```

- **Dependencies:** DX-Q4 typing, DX-L1 facade. **Migration impact:** additive; `setOverlayOptions` retained as the low-level path.
- **Tests:** declarative/imperative parity tests in `galavi/tests`.
- **Landed (2026-08-11, with DX-L1):** `viewer.control(name)` / `viewer.tool(name)` handles with `.configure(options)` / `.enable(enabled?)` / `.enabled`, taking the same typed option bags as the declarative `controls` / `tools` keys (`OrbitControlOptions`/`FlyControlOptions`/`PanZoomControlOptions`; `OverlayOptionsMap`-based tool bags). One normalization path serves config and imperative calls. Tools map to built-in overlays: crosshair → `"crosshair"`, ruler → `"ruler"`, roi → `"roiselector"`, magnifier → `"magnifier-2d"`/`"magnifier-3d"` (dimension pin via the string form or a `dimension` key in the options bag; unpinned defaults to the view kind — 3d on volume views, 2d on slice views). Implementation notes:
  - Controls are creation-only at the low level, so `control(name).configure/enable` re-instantiates the view's control chain through `controlRegistry` + `BaseView.setControls` — the parity bridge; no low-level API change was needed.
  - Live tool attach/detach goes through `overlayRegistry` + `BaseView.addOverlay/removeOverlay`. The Viewer tracks live overlay instances per view keyed by creation type (zipped from the built `ViewConfig.overlays` order, which `createView` preserves) because overlay classes do not reliably self-report their registry type — `MagnifierOverlay`'s static `overlayType` is always `"magnifier-2d"`, even for 3D instances.
  - The declarative mirror (`viewer.config`) stays in sync, so control/tool intent survives mode transitions and rebuilds.
  - Schema refinement: the magnifier tool rejects a bare `true` (a dimension pin or options bag is required); `tool("magnifier").enable()` produces `{}` (kind-default dimension) to stay inside the schema. The M6 example's `configure({ enabled, unit })` lands as `configure({ visible, unit })` / `enable(enabled)` — `visible` is the `OverlayOptionsMap` key, no `enabled` alias was invented.
  Tests: `galavi/tests/viewer.test.ts` ("controls and tools runtime parity" block — defaults per mode, live chain rebuild, overlay attach/update/detach, magnifier dimension pin/swap, transition survival, unknown-name errors).
- **Owner decision:** accepted. Implemented 2026-08-11 (hosted by the DX-L1 facade, as proposed).

---

## Larger architectural changes

### DX-L1: High-level `Viewer` facade and `createViewer`

- **Status:** implemented (2026-08-11)
- **Affected:** every example and first-time developer; common portions of Cerevi setup.
- **Current usage:** applications assemble galavi state/view/layer topology before any data is visible.
- **Pain:** the simplest scientific result is obscured by renderer architecture; common setup exceeds the three-line heuristic by an order of magnitude.
- **Frequency:** every application. **Severity:** high. **Complexity:** high.
- **First-time impact:** the highest-impact item for adoption; this is the first-run experience.
- **Owning package:** galavi (or an owner-approved companion package — repository policy currently discourages non-critical galavi core changes; owner sign-off must explicitly authorize the high-level DX work or choose the companion package. A private `createViewer` inside examples is explicitly rejected as hiding the demonstrated cross-consumer API gap).
- **Proposed improvement:** a format-neutral high-level `Viewer` owning one dataset session, common modes, channel intent, camera fit, controls/tools, loading state, and a `viewer.galavi` low-level escape hatch. Full schema, required call forms, declarative/imperative one-to-one mapping, and low-level translation table: `../engineering-cleanup-plan.md` section 15. Normal `Viewer` use must not expose GPU device, canvas format, tile pool, texture, buffer, shader, or render-pipeline concepts.
- **Expected application-code reduction:** simple app from 20–40 lines to 2–3; shared examples orchestration reduced by hundreds of lines.

```ts
// Before
const info = await openOMEZarr(url);
const physical = getPhysicalSpace(info);
const galavi = await createGalavi({ state: buildState(info, physical), views: buildViews(canvas) });
galavi.setActiveView("main");

// After
const viewer = await createViewer("#app", { source: { type: "ome-zarr", url } });
```

- **Dependencies:** DX-M1 (resolver), DX-M2 (status), DX-M3 (channels), DX-Q5 (naming), DX-Q4/DX-M6 (typed tools). **Migration impact:** additive facade; `createGalavi` retained and documented separately for advanced multi-view/layer/plugin composition. Cerevi migration boundary: `engineering-cleanup-plan.md` section 17.1.
- **Tests:** schema parity, serialization, and translation contract tests against the low-level scene API in `galavi/tests`; `galavi/DESIGN.md` must document low-level vs high-level ownership.
- **Landed (2026-08-11):** `createViewer(element, config?)` + `Viewer` in `galavi/src/viewer/` (`types.ts` — the JSON-serializable schema; `viewer.ts` — the facade), exported from the galavi entry beside `createGalavi`. Owner sign-off granted via the accepted Track B decisions (§19.1: export from `galavi`). Final API notes:
  - **Target:** selector, container (Viewer creates/owns the canvas — a 2×2 canvas grid in `"quad"` mode), or canvas (framework ownership; `"quad"` rejects with an actionable error since the Viewer cannot own the layout).
  - **Schema:** exactly §15.2 — `source`, `mode`, `channels`, `projection`, `camera`, `controls`, `tools`, `modeOverrides`; JSON-serializable, verified by round-trip tests. `viewer.config` mirrors the current declarative intent (imperative changes reflected), which is what makes §15.4 parity testable.
  - **Open:** `await viewer.open(source)` resolves with the `ResolvedDataset` (decision 19.4 naming), rejects with the resolver error as-is (`cause` chains preserved — DX-M2); `viewer.status` / `viewer.error` expose idle/loading/ready/error. Replacing a dataset is one awaited call; a superseded open rejects with `ViewerSupersededError` and never clobbers newer state.
  - **Translation (§15.5):** the Viewer resolves one dataset via `openDataset`, builds `State` (physical from the dataset + promoted channel names, one typed layer per channel with nested `options.selection.c`, no `maxPoolSize` — the DX-M4 policy owns budgets) and `ViewConfig`s (mode → view type/controls/overlays/canvas), and delegates creation/mounting to `createGalavi`. Camera math delegates to `frameVolumeCamera`/`fitSliceCamera`; `viewer.galavi` is the escape hatch (replaced on open/transitions — do not cache it).
  - **`mode: "auto"`:** capability-aware per §16 and decision 19.6 — z=1 → slice; z>1 → volume when `capabilities.supports3D && supportsVolumePreview`; else slice. `viewer.availableModes` exposes the meaningful mode subset (volume/quad for 3D data, slice only for 2D).
  - **Normal Viewer use exposes no GPU device, canvas format, tile pool, texture, buffer, shader, or render-pipeline concept.**
  - Tests: `galavi/tests/viewer.test.ts` (40 tests) — translation, status/failure/supersession, channel parity, projection, transitions, overrides, controls/tools, camera, quad, serialization, escape hatch/teardown. `DESIGN.md` remains a follow-up task (Track B documentation pass), as does the consumer migration.
- **Owner decision:** accepted (export from `galavi`, decision 19.1). Implemented 2026-08-11.

### DX-L2: First-class mode transitions

- **Status:** implemented (2026-08-11, with DX-L1)
- **Affected:** Brain, Open, and Cerevi volume/slice/quadrant modes. Examples: `galavi-examples/src/viewer/index.ts`, `src/viewer/modes/*`. Cerevi: mode components and `galavi-setup.ts` remount logic.
- **Current usage:** examples destroy/recreate galavi and manually transfer focus; Cerevi preconfigures and remounts views with framework guards.
- **Pain:** `viewer.mode = "volume"` is not currently an application-level operation; view IDs, layout, and async mounting leak out.
- **Frequency:** every multi-mode app. **Severity:** high. **Complexity:** high.
- **First-time impact:** switching view mode — an obvious thing to try — requires understanding the mount lifecycle.
- **Owning package:** galavi.
- **Proposed improvement:** high-level mode/layout controller with last-write-wins async transitions, stable focus/channels, and `viewer.ready` for callers that need completion. Keep low-level explicit mount APIs.
- **Expected application-code reduction:** 80–150 lines in examples and simpler common Cerevi transitions; advanced Cerevi layouts may remain low-level.

```ts
// Before
state.mode = "volume";
destroyGalavi();
await loadAndBuildAgainPreservingFocus();

// After
viewer.mode = "volume";
await viewer.ready;
```

- **Dependencies:** DX-L1 facade; DX-M2 status channel carries transition state. **Migration impact:** additive; advanced multi-view scenes stay on `createGalavi` / `viewer.galavi`.
- **Tests:** mode-transition and focus-preservation tests in `galavi/tests`; Cerevi manual Volume/Slice/Quadrant/Grid smoke checks per section 17.1.
- **Landed (2026-08-11, with DX-L1):** `viewer.mode = "volume"` (sync setter, validated) + `await viewer.ready` for completion; `viewer.resolvedMode` reports the post-auto-resolution mode. Mechanism:
  - **Rebuild, not remount:** galavi view/layer topology is fixed at `createGalavi` time (view layer instances are constructed from the initial config), so a mode transition destroys the current Galavi and creates a fresh one whose view type/layer set match the target mode — the same destroy/recreate pattern examples hand-rolled, now internalized. Layer/channel intent is rebuilt from the Viewer's channel model, so it survives trivially.
  - **Focus preservation:** the Viewer subscribes to the low-level state and tracks the camera target as the physical focus. On transition, the new mode's fit camera is computed first, then translated so its target lands exactly on the preserved focus (position shifts by the same delta). An explicit `target` in the declared camera (or a mode override of `camera: "fit"`) wins over preservation.
  - **Last-write-wins:** every open/transition carries a revision token checked after each await; superseded operations destroy what they built and reject with `ViewerSupersededError`. Rapid flips (`slice→volume→slice`) skip intermediate application entirely and settle on the final mode; the pending-intent comparison (not the last-applied mode) decides whether a setter call starts a transition.
  - `"quad"` enters a 2×2 layout (three orthogonal slice planes + volume view, viewer-owned canvases; container targets only). In quad the shared unified camera applies to all four views and the XY plane view holds the active/event view — a documented v1 limitation.
  Tests: `galavi/tests/viewer.test.ts` ("mode transitions" + "modeOverrides" blocks — focus preservation across slice↔volume round trips, rapid-flip last-write-wins, pre-open mode intent, per-mode override entry/exit semantics).
- **Owner decision:** accepted. Implemented 2026-08-11 (hosted by the DX-L1 facade, as proposed).

---

## Hygiene

### DX-H1: Align adapter prepublish gates with galavi core

- **Status:** implemented (2026-08-11)
- **Affected:** release process only.
- **Current usage:** `galavi-ome-zarr-adapter/package.json` runs `"prepublishOnly": "bun run build"` (build only), while `galavi/package.json` runs `"prepublishOnly": "bun run typecheck && bun run test && bun run build"`. (galavi-ome-tiff-adapter matches the zarr adapter.)
- **Pain:** adapters can publish without typecheck/tests passing — a release-integrity gap, not a DX defect.
- **Frequency:** per publish. **Severity:** low. **Complexity:** trivial.
- **First-time impact:** none directly; protects consumers of published artifacts.
- **Owning package:** galavi-ome-zarr-adapter (and galavi-ome-tiff-adapter for consistency).
- **Proposed improvement:** align prepublish gates with core: `bun run typecheck && bun run test && bun run build`.
- **Expected application-code reduction:** n/a.
- **Dependencies:** none. **Migration impact:** none (publish-time only).
- **Tests:** covered by the gate itself.
- **Owner decision:** approved (2026-08-11) — both adapters now run `bun run typecheck && bun run test && bun run build` on `prepublishOnly`.

---

## Decision log

Append one row per decision. Rejected proposals must be kept in their issue section above with the rejection rationale, so example workarounds do not silently reappear later.

| Date | Issue | Decision | Rationale |
|---|---|---|---|
| 2026-08-11 | DX-Q1 (examples side) | implemented (partial) | Typed `VolumeLayerConfig`/`SliceLayerConfig` factories + regression tests landed in galavi-examples; core dev-time key diagnostics still proposed. |
| 2026-08-11 | DX-Q2 | implemented (examples) | `galavi.setTarget` adopted for orbit cameras; typed `getState`/`setState` retained for fly/slice cameras (verified `setTarget` caveat). No core change. |
| 2026-08-11 | DX-Q3 | implemented (examples) | `getChannelColor`/`buildContrastLimits`/`clampContrastLimits` adopted in `session.ts`; curated story overrides applied explicitly last. |
| 2026-08-11 | DX-Q1 (core side) | implemented | Development-only `console.warn` for unknown option keys on built-in tiled image layers (construction + `setOptions` path), gated by `import.meta.env?.DEV !== false` so production builds tree-shake it; warning chosen over rejection to stay non-breaking. `selection` documented as the only non-spatial dimension path. |
| 2026-08-11 | DX-Q4 | implemented | `OverlayOptionsMap` exported; `setOverlayOptions` and `ViewConfig.overlays` type built-in overlay keys (generic conditional, not overloads, so typos can't fall through to the plugin escape hatch). Consumers compile unchanged. |
| 2026-08-11 | DX-Q5 | deferred | Low-level `render.mode` → `volumeProjection` rename deferred to the Track B pass introducing high-level `projection`, avoiding a standalone breaking change; owner accepted the deferral. |
| 2026-08-11 | DX-Q5 | implemented | Rename landed without alias alongside Track B: `render.mode` → `render.volumeProjection` in galavi core (`types.ts`, volume layer), with all consumers migrated (galavi-examples, cerevi-web, galavi-docs, READMEs) and no compatibility alias; test asserts the old key is ignored. |
| 2026-08-11 | DX-M5 | implemented (adapter side) | `openOMEZarrPlate` shipped in `galavi-ome-zarr-adapter/src/plate.ts`: typed `OMEZarrPlateInfo` with rows/columns/wells/fields, per-field `SourceDescriptor`s, v0.4+v0.5 attrs, actionable errors, no `any` at the boundary; fixture tests in `tests/plate.test.ts`. Examples migration pending the examples pass. |
| 2026-08-11 | DX-H1 | implemented | Both adapters' `prepublishOnly` now gate on `typecheck && test && build`, matching galavi core. |
| 2026-08-11 | DX-M4 | implemented | Budget policy moved verbatim into core: `planVolumePreview` in `galavi/src/utils/tile/volume-policy.ts` (384 slabs / 1296 tiles / 512² texels / +64 pool headroom), applied by `VolumeLayer` via the new memoized `applyEffectiveSourcePolicy` hook only when no explicit `maxPoolSize` is set (explicit override wins); pool sized to `maxTiles + 64`. Example `makeVolumeSource`/`wrapVolumeSource` deleted — nothing stayed local (picking and the contact sheet already read the full pyramid). urlTemplate-only sources can't be strided and pass through (documented). |
| 2026-08-11 | DX-M1 | implemented | Format-neutral `ResolvedDataset` + `openDataset(source)` in `galavi/src/dataset.ts`, layering OVER the untouched per-layer `Data.source` registry. Resolvers registered via `registerDatasetResolver` (mirrors `registerSource`); `registerOMEZarrSource()` is the one adapter entry point registering both. Cached per source identity (type + canonical url, stable-serialization fallback) including in-flight promises; rejections evicted, `invalidateDataset`/`invalidateAllDatasets` for disposal. Channel visibility default follows the §16 policy table (metadata `active`, else first channel only) — not the examples' all-visible default; that curated behavior stays with consumers until the adoption pass. |
| 2026-08-11 | DX-M2 | implemented (low-level path) | Source-resolution failures are recorded on the layer and reject `whenLayerReady` instead of pending forever: `BaseLayer.loadStatus`/`loadError` + `LayerLoadStatus`/`LayerLoadState`, `TiledImageLayer` failure recording/signaling, `BaseView.getLayerStatus` + `ViewAccessor.getLayerStatus` status query. Registry-miss errors name the layer and registered types (mirroring `openDataset`); factory rejections recorded as-is with `cause` chains preserved, consistent with `openDataset`. Abort precedence: abort settles only its own waiter (aborted waiters never see late failures); a pre-aborted signal wins over a recorded error. `isReady`, removal/destroy semantics, and the `subscribe` channel unchanged. High-level `viewer.open` remains with DX-L1; consumers not yet migrated. |
| 2026-08-11 | DX-L1 | implemented | `createViewer(element, config?)` + `Viewer` landed in `galavi/src/viewer/` and are exported from the galavi entry (decision 19.1). §15.2 schema verbatim and JSON-serializable (`viewer.config` mirrors intent; round-trip tested); selector/container/canvas targets (19.5); `open` resolves with the `ResolvedDataset` (19.4) and rejects with DX-M2 causes, superseded opens reject `ViewerSupersededError`; capability-aware `mode: "auto"` (19.6) with `availableModes`; OMERO-active-then-first channel visibility respected (19.7); typed `modeOverrides` + `viewer.view(mode).configure` (19.8); high-level `projection` → `render.volumeProjection` (19.9). Translation composes `openDataset` + `createGalavi` + fit helpers — no fork of the scene model; layers carry explicit pyramid/fetch with no `maxPoolSize` (DX-M4 owns budgets). 40 contract tests in `galavi/tests/viewer.test.ts`. `DESIGN.md`, galavi-docs, and consumer migration remain follow-up tasks. |
| 2026-08-11 | DX-L2 | implemented | `viewer.mode = value` + `await viewer.ready`; transitions destroy/recreate the low-level instance (view topology is construction-fixed) with the physical focus preserved by translating the new mode's fit camera onto the tracked camera target — explicit `target`/`camera: "fit"` overrides win. Last-write-wins via revision tokens compared against pending intent, so rapid flips skip intermediate application and settle on the final mode. `"quad"` is a viewer-owned 2×2 layout (container targets only; XY plane view holds events — documented v1 limitation). |
| 2026-08-11 | DX-M3 | implemented | `viewer.channel(index).configure({ visible?, color?, contrast?, label? })` + `config` snapshot; the Viewer owns the `<view>-c<index>` layer-ID scheme and maps one channel operation onto every internal typed layer (nested `options.selection.c`) via `setRender`. One shared normalization/validation path for config and imperative calls (color → `#RRGGBB`, contrast clamped/ordered); intent survives mode transitions and dataset replacement. |
| 2026-08-11 | DX-M6 | implemented | `viewer.control(name)` / `viewer.tool(name)` with `.configure()/.enable()/.enabled`, same typed bags as the declarative keys (`ControlOptions` / `OverlayOptionsMap`-based). Controls re-instantiate the view's control chain via `controlRegistry` + `setControls` (controls are creation-only at the low level); tools attach/update/detach built-in overlays (crosshair/ruler/roiselector/magnifier-2d/3d) via `overlayRegistry` + `addOverlay/removeOverlay`, tracked per view by creation type because `MagnifierOverlay`'s static `overlayType` misreports 3D instances. Magnifier bare `true` rejected (dimension pin or options bag required); M6's aspirational `enabled` key landed as `visible`/`enable()` — no alias invented. |
| 2026-08-11 | DX-M6 | implemented | `viewer.control(name)` / `viewer.tool(name)` with `.configure()/.enable()/.enabled`, same typed bags as the declarative keys (`ControlOptions` / `OverlayOptionsMap`-based). Controls re-instantiate the view's control chain via `controlRegistry` + `setControls` (controls are creation-only at the low level); tools attach/update/detach built-in overlays (crosshair/ruler/roiselector/magnifier-2d/3d) via `overlayRegistry` + `addOverlay/removeOverlay`, tracked per view by creation type because `MagnifierOverlay`'s static `overlayType` misreports 3D instances. Magnifier bare `true` rejected (dimension pin or options bag required); M6's aspirational `enabled` key landed as `visible`/`enable()` — no alias invented. |
| 2026-08-11 | DX-L1/L2/M3/M6 (consumer side) | implemented | galavi-examples migrated onto the high-level Viewer: one `createViewer` per story open from the exact `story.viewer` ViewerConfig (snippets now serialize that same object — the "no high-level createViewer yet" label is gone); `session.ts`/`views.ts` deleted (metadata opening, channel normalization, layer expansion, camera fit, mode focus juggling all Viewer-owned); channel UI → `viewer.channel(i).configure`, toolbox → `viewer.tool(name)`, projection → `viewer.projection`, modes → `viewer.mode` + `await viewer.ready` with `ViewerSupersededError` for stale transitions. Brain orientation/picking stay story-local via the `viewer.galavi` escape hatch; the contact sheet remains a low-level paged multi-view module; plate hierarchy stays local on the typed adapter API. Two minimal core additions were required, with contract tests in `galavi/tests/viewer.test.ts`: `viewer.setSlicePoint(point)` (slice-index navigation + transition slice sync — the Viewer owned no z-navigation, and slice layers defaulted to the center slice regardless of the preserved focus) and edit-what-you-see `channel().configure` (a base-only edit was masked by the active mode's `modeOverrides` entry). Residual escape-hatch reads: the HUD cursor/resolution readout still reads `viewer.galavi` state (screen→physical mapping and camera read have no Viewer API — recorded here as a candidate Viewer addition, not worked around locally). |
| 2026-08-11 | DX-M5 (consumer side) | implemented | `src/stories/plate.ts` now reads plate/well/field layout exclusively through the adapter's `openOMEZarrPlate` — no zarrita access, no `any` casts, no hardcoded 32-field fallback (only real `well.images` fields are offered; representative field D/4/0 stays). The direct `zarrita` dependency was dropped from galavi-examples' package.json. |

---

## DX before/after measurements (2026-08-11)

Measured after the Track B landing (DX-L1/L2/M1–M6, Q4/Q5) and the
galavi-examples migration, against the pre-cleanup baseline recorded in this
audit. Test counts verified by running the suites on 2026-08-11 (all green):
galavi 227, galavi-ome-zarr-adapter 78, galavi-examples 49, cerevi-web 40.

| Path | Before | After |
|---|---|---|
| Minimal viewer | ~20–40 lines: `openOMEZarr` + `getPhysicalSpace` + channel/camera/layer assembly + `createGalavi` | 1 import + 1 `createViewer("#app", { source })` call |
| galavi-examples viewer orchestration | 1,519-line `viewer.ts` monolith | 664-line `index.ts` + small modules; `session.ts` (161 lines) and `views.ts` (167 lines) deleted — metadata opening, channel normalization, layer expansion, camera fit, and mode focus juggling are Viewer-owned |
| Mode change | ~80–150 lines of app orchestration (destroy/recreate, focus transfer, view-ID juggling) | one assignment: `viewer.mode = "volume"` (+ `await viewer.ready`) |
| Channel change | layer-ID suffix scans over `getState().layers` | `viewer.channel(i).configure({ visible, color, contrast })` |
| Plate hierarchy | direct `zarrita` + `attrs as any` + hardcoded 32 fields | typed `openOMEZarrPlate` — real `well.images` fields, no casts, no zarrita dependency |
| Volume tile budgets | example-local `makeVolumeSource` + `maxPoolSize` math on every volume path | automatic core policy (`planVolumePreview`); common paths carry no `maxPoolSize` |
| Common paths | raw `getState`/`setState` mutations for camera/channel operations | no `getState`/`setState` on any common example path (typed helpers and Viewer operations only) |
| 2026-08-11 | DX-M1 (Cerevi side, decision 14) | adopted (partial) | cerevi-web's `buildSetupContext` now normalizes the volume store through the adapter's `resolvedDatasetFromOMEZarr` into a `SetupContext.dataset` (one metadata open retained — `openOMEZarr` output feeds the resolver directly, no second open): channel labels/colors/contrast, default selection, physical space, and the volume layer's pyramid/fetch/`selection` spread all come from the resolved dataset, deleting Cerevi's duplicate `findChannelDim`/`buildChannels`/manual `getPhysicalSpace` wiring in `context.ts`/`layer-factories.ts`/`view-factories.ts`. Deliberately retained locally: specimen/mesh metadata and mode-file routing, precomputed per-plane slice sources (`fetch2DPlane` per storage plane with its own contrast metadata), anatomical orientation (`sliceDefs`/`storageReversed`), and all multi-source/multi-view/mesh composition on `createGalavi` (the four mode layouts do not fit `Viewer.mode`; typed `setOverlayOptions` already compiled unchanged per DX-Q4). Regression tests added for dataset metadata exposure and nested `selection.c` (default-selection spread with only `c` overridden). |

---

## Corrections — 2026-08-17 (superseded-design notice)

**Status of this document:** the entries above are a dated decision log and are
**not rewritten**. Several of them describe a design that has since been
replaced. This section records which entries are superseded and what actually
shipped, so no entry above is read as current API. The current architecture is
specified in `DESIGN.md` (rewritten 2026-08-17); the follow-up review driving
the replacement is `../review-0.md` (audit date 2026-08-16).

### Entries describing the superseded source-resolver design

Everything below is **historical** — the named mechanisms were removed with no
aliases:

- **DX-M1 (core mechanism).** The `ResolvedDataset` contract,
  `registerDatasetResolver` / `datasetResolverRegistry`, the per-source-identity
  resolution cache (`datasetCacheKey`, `invalidateDataset`,
  `invalidateAllDatasets`), `SourceDescriptor`-based `openDataset(source)`, and
  the adapter-side `registerOMEZarrSource()` registration entry were replaced
  by the Dataset class contract: kinds register via `registerDataset(kind,
  factory)` keyed on an explicit `DatasetConfigMap` entry (module
  augmentation); `openDataset(config)` constructs and loads a **fresh**
  `Dataset` per call with **no cache** (disposal is the caller's job;
  `viewer.open(dataset)` adopts a pre-opened instance with ownership transfer);
  duplicate kind registration throws. `getDatasetCapabilities(pyramid)`
  survives, now returning format-neutral `{ modes, defaultMode }` capabilities
  instead of image-shaped facts.
- **DX-M2 (framing only).** The load-status channel landed as described and is
  current (`loadStatus`/`loadError`, `getLayerStatus`, `whenLayerReady`
  rejection). What is gone is the *source-descriptor* framing: per-layer
  `Data.source` resolution through `sourceRegistry`/`registerSource` no longer
  exists — layers consume explicit `pyramid`/`fetch`/`geometry` from a Dataset,
  and failures are dataset/layer load failures.
- **DX-L1 (naming and composition).** The facade landed and survives, but:
  the config key is `dataset` (not `source`); the escape hatch is
  `viewer.engine` (not `viewer.galavi`); the low-level orchestrator is
  `ViewerEngine`/`createViewerEngine` with `ViewerEngineConfig` (not
  `Galavi`/`createGalavi`/`GalaviConfig` — removed completely, no aliases);
  `open()` resolves with the `Dataset` (not `ResolvedDataset`). The facade now
  also awaits every generated layer's structural readiness before
  `viewer.ready` settles (ARCH-1), and high-level tool config is JSON-only —
  functions throw with an actionable error (API-4).
- **DX-L2.** Current, with the rename: transitions destroy/recreate the
  `ViewerEngine`, not a "Galavi".
- **DX-M5.** `openOMEZarrPlate` shipped as described but moved: it is exported
  from the `galavi/ome-zarr` subpath, not a separate adapter package.
- **DX-H1 and the adapter-package references** (the "Verified mechanisms"
  header, DX-M5, decision-log rows): the standalone `@galavi/ome-zarr-adapter`
  package is **decommissioned** (deprecated README, out of the workspace).
  OME-Zarr support ships inside `galavi` as the `galavi/ome-zarr` subpath;
  `zarrita` is a normal dependency of `galavi`, so `npm install galavi`
  suffices. `@galavi/ome-tiff-adapter` survives, migrated to the new Dataset
  contract (`registerDataset("ome-tiff", …)` + `DatasetConfigMap`
  augmentation) as the multi-loader proof.
- **Decision log and measurements table rows** mentioning `createGalavi`,
  `viewer.galavi`, `ResolvedDataset`, `registerDatasetResolver`, or
  `@galavi/ome-zarr-adapter` are accurate records of what landed on
  2026-08-11 and are superseded per the above.
- **`docs/plans/viewer-dataset-refactor-notes.md`** (2026-08-14) records the
  intermediate refactor state: it still names the `"image"` dataset kind
  (since renamed `"ome-zarr"`), `deriveDefaults()` (replaced by
  `capabilities`), `zarrita` as an optional peer (now a normal dependency),
  and package-wide `sideEffects` (now narrowed to the OME-Zarr entry). It
  carries a historical-status banner.

### What actually shipped (2026-08-17)

- **Three package entries.** `galavi` (common: `createViewer`/`Viewer`, Viewer
  config/status/event types, `openDataset`/`Dataset`/`DatasetConfig`/
  `DatasetConfigMap`/`registerDataset`, common types, theme helpers);
  `galavi/advanced` (`createViewerEngine`/`ViewerEngine`, `State`/`ViewConfig`/
  `LayerConfig`/`LayerPatch`, `updateLayers`, registries, base + built-in
  classes, callback-bearing overlay options, camera/tile/plugin utilities —
  re-exporting the common root); `galavi/ome-zarr` (self-registers
  `"ome-zarr"`; `openOMEZarrDataset`, `openOMEZarr`, `fetch2DPlane`, plate
  helpers, `ImageDataset.info`/`OMEZarrInfo`).
- **Typed loader identity.** `DatasetConfig` is the union of
  `DatasetConfigMap` configs — wrong configs fail at compile time; duplicate
  registration throws. Configs are `{ type: "ome-zarr" | "ome-tiff" | "mesh",
  source }`. No `type: "image"` kind exists.
- **Shared runtime layers and truthful readiness (ARCH-1).** The engine owns
  one runtime `BaseLayer` per state-layer ID across views (per-view GPU
  renderers remain), one tracked load per layer with recorded status/error,
  and the Viewer awaits all generated layers' structural readiness — surface
  failures reject `viewer.ready`/`whenLayerReady`, never swallowed.
  `MeshDataset` hands parsed geometry to its surface layer (one fetch/parse).
- **Ownership (API-5).** `openDataset(config)` results are caller-owned;
  `viewer.open(dataset)` transfers ownership at invocation — the Viewer
  disposes on supersession/replacement/rebuild-failure/`destroy()`.
- **Events (API-4).** High-level tool config is JSON-only; ROI runtime events
  ship as `viewer.on("roiChange" | "roiActiveChange", handler)` returning an
  unsubscribe; callback-bearing overlay options remain on the low-level engine
  path in `galavi/advanced`.
- **Packaging.** `sideEffects` narrowed to the OME-Zarr entry; `zarrita` is a
  normal dependency; no companion adapter install is required.

Entries not listed above (DX-Q1–Q5, DX-M3, DX-M4, DX-M6 modulo the API-4
amendment) describe mechanisms that are still current.
