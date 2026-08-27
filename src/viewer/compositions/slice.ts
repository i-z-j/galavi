/**
 * Slice reference composition — one 2D slice view (the x/y plane).
 *
 * Supports any Dataset whose primary resource is an image pyramid (2D or
 * 3D). Builds one additive slice layer per channel from the image resource;
 * the plan's bindings drive the Viewer's channel updates and slice-focus sync.
 */

import { resolveAxes } from "../../utils";
import {
  MAIN_VIEW_ID,
  buildImageLayers,
  primaryResourceOf,
  unsupportedPrimary,
  type CompositionPlan,
  type ViewerComposition,
} from "../contract";

export const sliceComposition: ViewerComposition = {
  type: "slice",

  supports(dataset) {
    return primaryResourceOf(dataset)?.kind === "image-pyramid";
  },

  build({ dataset, channels, transform }): CompositionPlan {
    const primary = primaryResourceOf(dataset);
    if (primary?.kind !== "image-pyramid") throw unsupportedPrimary("slice", dataset);
    const layers = buildImageLayers(primary, {
      view: "slice", prefix: "slice", channels, transform,
    });
    const layerIds = layers.map((layer) => layer.id);
    return {
      layers,
      views        : { [MAIN_VIEW_ID]: { type: "slice", layers: layerIds } },
      activeViewId : MAIN_VIEW_ID,
      layout       : { kind: "single" },
      bindings     : {
        channels         : new Map(channels.map((channel) => [
          channel.index,
          [`slice-c${channel.index}`],
        ])),
        projectionLayers : [],
        slicePlanes      : [{ viewId: MAIN_VIEW_ID, layerIds, axes: resolveAxes(["x", "y"]) }],
      },
    };
  },
};
