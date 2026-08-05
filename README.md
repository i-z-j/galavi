# Galavi

Galavi is a WebGPU visualization library for shared-state scientific viewers. It renders volume, slice, surface, shape, and related data types through one state model and a small set of pluggable building blocks.

![Galavi](assets/screenshot.webp)

## Features

- WebGPU-native rendering for multi-view scientific scenes.
- Shared, serializable `State` model — physical space, layers, exploration — diffable across view layouts.
- Tile-based multi-resolution loading for large OME-Zarr and similar pyramidal datasets.
- Built-in views: `volume` (3D perspective), `slice` (2D ortho), `navigator` (3D overview).
- Built-in controls: `orbit`, `fly`, `panzoom` — pure reducers, view-local.
- Automatic physical-scale resolution selection with coarse-first loading and dynamic visible storage chunks.
- Built-in overlays: `crosshair`, `ruler`, `roiselector`, `magnifier-2d`, `magnifier-3d`, `foldablepanel` — bound to a live view.
- Built-in layers: volume, slice, surface, shape, points, network, segmentation, vectors, tracks.
- FUI overlay theme, customizable via `GalaviConfig.theme` and consumable by apps through `--galavi-*` CSS custom properties.
- Extensible registries for layers, views, controls, and overlays — add your own without forking.
- Framework-agnostic canvas mounting; works with Vue, React, vanilla, etc.

## Install

```bash
npm install galavi
# or
bun add galavi
```

## References

- **Documentation:** [i-z-j.github.io/galavi-docs](https://i-z-j.github.io/galavi-docs/)
- **Live examples:** [i-z-j.github.io/galavi-examples](https://i-z-j.github.io/galavi-examples/)
- **Source:** [github.com/i-z-j/galavi](https://github.com/i-z-j/galavi)

## License

GPL-3.0
