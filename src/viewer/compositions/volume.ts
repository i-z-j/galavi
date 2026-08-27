/**
 * Volume reference composition — one full-frame 3D view.
 *
 * Supports any Dataset whose primary resource is a mesh, or an image pyramid
 * within the automatic volume tile-budget policy (z > 1). Builds one additive
 * volume layer per channel from the image resource, or the single surface
 * layer from the mesh resource.
 */

import {
  MAIN_VIEW_ID,
  buildImageLayers,
  buildMeshLayer,
  primaryResourceOf,
  supportsVolumePyramid,
  unsupportedPrimary,
  type CompositionPlan,
  type ViewerComposition,
} from "../contract";

export const volumeComposition: ViewerComposition = {
  type: "volume",

  supports(dataset) {
    const primary = primaryResourceOf(dataset);
    if (primary?.kind === "mesh") return true;
    if (primary?.kind === "image-pyramid") return supportsVolumePyramid(primary.pyramid);
    return false;
  },

  build({ dataset, channels, projection, transform }): CompositionPlan {
    const primary = primaryResourceOf(dataset);
    let plan: Pick<CompositionPlan, "layers" | "bindings">;
    if (primary?.kind === "image-pyramid") {
      const layers = buildImageLayers(primary, {
        view: "volume", prefix: "volume", channels, projection, transform,
      });
      const layerIds = layers.map((layer) => layer.id);
      plan = {
        layers,
        bindings: {
          channels         : new Map(channels.map((channel) => [
            channel.index,
            [`volume-c${channel.index}`],
          ])),
          projectionLayers : layerIds,
          slicePlanes      : [],
        },
      };
    } else if (primary?.kind === "mesh") {
      const layer = buildMeshLayer(primary, { prefix: "volume" });
      plan = {
        layers   : [layer],
        bindings : { channels: new Map(), projectionLayers: [], slicePlanes: [] },
      };
    } else {
      throw unsupportedPrimary("volume", dataset);
    }
    return {
      ...plan,
      views        : { [MAIN_VIEW_ID]: { type: "volume", layers: plan.layers.map((l) => l.id) } },
      activeViewId : MAIN_VIEW_ID,
      layout       : { kind: "single" },
    };
  },
};
