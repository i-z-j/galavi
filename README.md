# Galavi

Galavi connects a declarative Dataset boundary to an application-facing Viewer boundary — two peers whose contracts live at `dataset/contract.ts` and `viewer/contract.ts`. Dataset adapters (`dataset/adapters/`) and Viewer compositions (`viewer/compositions/`, which also owns composition registration and resolution) implement those contracts; ViewerRuntime, views, layers, controls, overlays, streaming, LOD, and GPU residency are the reusable infrastructure between them. Built on WebGPU, it renders volume, slice, surface, shape, and related data types through one state model and a small set of pluggable building blocks.

![Galavi](assets/screenshot.webp)

## Features

- **High-level `Viewer` API** — `createViewer(element, config)` gives you a complete scientific viewer in one call: dataset session, compositions, channels, camera fit, controls/tools, and loading status from a single JSON-serializable `ViewerConfig`.
- **`openDataset` dataset-adapter registry** — format-neutral dataset contract (physical space, normalized channels, typed runtime **resources** such as an image pyramid/fetch pair or mesh geometry; compositions, not datasets, translate resources into scenes); adapters self-register via `registerDatasetAdapter` with typed configs (`"ome-zarr"` comes from the `galavi/ome-zarr` subpath, `"mesh"` is built in), or pass a direct one-off adapter to `openDataset(config, { adapter })`.
- WebGPU-native rendering for multi-view scientific scenes.
- **Portable `State`** — `viewer.getState()` snapshots the complete reproducible session (dataset descriptor, resolved composition, channels, projection, the live camera, tool/ROI state) as pure JSON; `await viewer.setState(state)` restores it atomically and `viewer.subscribe(listener)` reports committed snapshots. Transport is plain `JSON.stringify`/`JSON.parse` — nothing is silently dropped: function-backed values reject.
- **Compositions** — how a dataset + state become a scene: built-in `slice`, `volume`, `quad`, and `grid` (a paged slice pool) register through the same `registerComposition` mechanism as custom ones; pass a direct implementation for one-off customization (`composition: { implementation }`).
- Shared runtime `State` model — physical space, layers, exploration — diffable across view layouts; JSON-portable only while every layer's `data` is declarative.
- Tile-based multi-resolution loading for large OME-Zarr and similar pyramidal datasets, with an automatic bounded volume tile-budget policy.
- Built-in views: `volume` (3D perspective), `slice` (2D ortho), `navigator` (3D overview).
- Built-in controls: `orbit`, `fly`, `panzoom` — pure reducers, view-local.
- Automatic physical-scale resolution selection with coarse-first loading and dynamic visible storage chunks.
- Built-in overlays: `crosshair`, `ruler`, `roi-selector`, `magnifier-2d`, `magnifier-3d`, `foldable-panel` — bound to a live view, with typed option bags (`OverlayOptionsMap`).
- Built-in layers: volume, slice, surface, shape, points, network, segmentation, vectors, tracks.
- HCS support via the `galavi/ome-zarr` subpath's typed `openOMEZarrPlate` (plate/well/field hierarchy with ready-to-open dataset configs).
- FUI overlay theme, customizable via `ViewerConfig.theme` and consumable by apps through `--galavi-*` CSS custom properties.
- Extensible registries for layers, views, controls, and overlays — add your own without forking.
- Framework-agnostic canvas mounting; works with Vue, React, vanilla, etc.

## Install

```bash
npm install galavi
# or
bun add galavi
```

One package is enough: `zarrita` (the OME-Zarr store client used by the
`galavi/ome-zarr` subpath) installs transitively.

## Quickstart

Two imports, one call — a complete viewer against an OME-Zarr store:

```ts
import { createViewer } from "galavi";
import { omeZarr } from "galavi/ome-zarr";

const viewer = await createViewer("#app", {
  dataset: omeZarr("https://server/data.zarr"),
});
```

Every config key has an imperative equivalent: `await viewer.setComposition("volume")`,
`viewer.projection = "mip"`, `viewer.channel(1).configure({ contrast: [0.02, 0.2] })`,
`viewer.tool("ruler").enable()`, `await viewer.open(dataset)`.

Snapshot, share, and restore the whole session as one portable document:

```ts
const snapshot = viewer.getState();                        // → pure JSON document
const shared = JSON.stringify(snapshot);                   // transport is app-owned
await viewer.setState(JSON.parse(shared));                 // atomic restore
```

Use the low-level **`createViewerRuntime`** API (same root entry) when you need
what the Viewer does not own: arbitrary multi-view scenes, custom registered
layers/controls/overlays/views, or non-image layers. `viewer.runtime` is the
escape hatch for one-off advanced operations. See the
[design notes](https://i-z-j.github.io/galavi-docs/guide/design) for the
layering and ownership model.

## References

- **Documentation:** [i-z-j.github.io/galavi-docs](https://i-z-j.github.io/galavi-docs/)
- **Live examples:** [i-z-j.github.io/galavi-examples](https://i-z-j.github.io/galavi-examples/)
- **Source:** [github.com/i-z-j/galavi](https://github.com/i-z-j/galavi)

## License

Apache-2.0 (previously GPL-3.0 — infrastructure intended for embedding needs a
permissive license with an explicit patent grant).
