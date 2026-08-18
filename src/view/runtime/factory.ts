/**
 * View factory — instantiate a fully wired view from a `ViewConfig`.
 *
 * Runtime layer instances are NOT created here: the ViewerEngine owns one
 * `BaseLayer` per state-layer ID (ARCH-1) and this factory hands each view
 * references from that shared map. Views referencing the same layer ID share
 * the instance; per-view GPU resources stay per view/layer pair.
 */

import type { ID, ViewConfig } from "../../types";
import type { ViewerEngine } from "../../viewer";
import {
  viewRegistry,
  overlayRegistry,
  controlRegistry,
} from "../../registry";
import type { BaseControl } from "../../control";
import type { BaseOverlay } from "../../overlay";
import type { BaseLayer } from "../../layer";
import type { BaseView } from "../base";

export interface ViewRuntime {
  config      : ViewConfig;
  view        : BaseView;
  layers      : Map<string, BaseLayer>;
  overlays    : Map<string, BaseOverlay>;
  activatable : boolean;
  label?      : string;
}

/**
 * Create and wire a fully initialized view from a ViewConfig.
 *
 * `runtimeLayers` is the engine-owned map of shared layer instances built
 * from `state.layers`; the returned ViewRuntime's `layers` maps the view's
 * configured IDs to those shared instances.
 */
export function createView(
  name          : string,
  config        : ViewConfig,
  runtimeLayers : ReadonlyMap<ID, BaseLayer>,
  engine        : ViewerEngine,
): ViewRuntime {
  const view = viewRegistry.create(config.type, name as ID);
  view.setOwner(engine);
  view.autoResize = config.autoResize ?? true;

  // Resolve the view's layer references against the engine-owned runtime map.
  const layers = new Map<string, BaseLayer>();
  for (const layerName of config.layers) {
    const layer = runtimeLayers.get(layerName);
    if (!layer) {
      throw new Error(
        `[createView] View "${name}" references layer "${layerName}" which is not in state.layers`,
      );
    }
    layers.set(layerName, layer);
  }

  // Register control(s)
  const localControls: BaseControl[] = [];
  for (const [ctrlType, ctrlOptions] of Object.entries(config.controls ?? {})) {
    // Registry boundary is untyped: built-in control factories re-parse their
    // own options (see `opt*` readers), so a plain options bag suffices here.
    localControls.push(controlRegistry.create(
      ctrlType,
      `${name}-${ctrlType}`,
      ctrlOptions as Record<string, unknown> | undefined,
    ));
  }
  if (localControls.length > 0) {
    view.setControls(localControls);
  }

  // Attach overlays
  const overlayMap = new Map<string, BaseOverlay>();
  for (const [overlayType, overlayOpts] of Object.entries(config.overlays ?? {})) {
    const overlay = overlayRegistry.create(overlayType);
    // Registry boundary is untyped: built-in overlays re-parse their own
    // options in `setOptions`, so a plain options bag suffices here.
    overlay.setOptions?.(overlayOpts as Record<string, unknown> | undefined);
    view.addOverlay(overlay);
    overlayMap.set(overlayType, overlay);
  }

  // Wire layers → view
  for (const entry of layers.values()) {
    view.addLayer(entry);
  }

  return {
    config,
    view,
    layers,
    overlays    : overlayMap,
    activatable : config.activatable ?? true,
    label       : config.label,
  };
}
