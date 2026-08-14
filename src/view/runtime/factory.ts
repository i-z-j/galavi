/**
 * View factory — instantiate a fully wired view from a `ViewConfig`.
 */

import type { ID, LayerConfig, ViewConfig } from "../../types";
import type { Galavi } from "../../main";
import {
  layerRegistry,
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
 * Returns a ViewRuntime with populated runtime instances.
 */
export function createView(
  name          : string,
  config        : ViewConfig,
  layerConfigs  : LayerConfig[],
  galavi        : Galavi,
): ViewRuntime {
  const view = viewRegistry.create(config.type, name as ID);
  view.setOwner(galavi);
  view.autoResize = config.autoResize ?? true;

  // Instantiate layer entries
  const layerByName = new Map(layerConfigs.map((layer) => [layer.id, layer]));
  const layers      = new Map<string, BaseLayer>();
  for (const layerName of config.layers) {
    const layerDesc = layerByName.get(layerName);
    if (!layerDesc) {
      throw new Error(
        `[createView] View "${name}" references layer "${layerName}" which is not in state.layers`,
      );
    }
    layers.set(layerName, layerRegistry.create(layerDesc.type, layerName, layerDesc));
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
