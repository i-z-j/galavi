/**
 * Quad reference composition — the 2×2 layout: three orthogonal slice planes
 * (xy, xz, yz) plus one volume view.
 *
 * Supports the same datasets as the volume composition when the primary
 * resource is an image pyramid (mesh primaries are volume-only). Each view
 * gets one additive layer per channel; the plane views pin their in-plane
 * axes, the volume view carries the accumulation projection.
 */

import { resolveAxes, type AxisMap } from "../../utils";
import {
  buildImageLayers,
  primaryResourceOf,
  supportsVolumePyramid,
  unsupportedPrimary,
  type CompositionPlan,
  type CompositionViewConfig,
  type ViewerComposition,
} from "../contract";

/** The three orthogonal slice planes, with their in-plane axes. */
const PLANES: readonly { id: string; axes: readonly string[] }[] = [
  { id: "quad-xy", axes: ["x", "y"] },
  { id: "quad-xz", axes: ["x", "z"] },
  { id: "quad-yz", axes: ["y", "z"] },
];
const VOLUME_VIEW_ID = "quad-3d";

export const quadComposition: ViewerComposition = {
  type: "quad",

  supports(dataset) {
    const primary = primaryResourceOf(dataset);
    return primary?.kind === "image-pyramid" && supportsVolumePyramid(primary.pyramid);
  },

  build({ dataset, channels, projection, transform }): CompositionPlan {
    const primary = primaryResourceOf(dataset);
    if (primary?.kind !== "image-pyramid") throw unsupportedPrimary("quad", dataset);

    const layers: CompositionPlan["layers"] = [];
    const views: Record<string, CompositionViewConfig> = {};
    const channelBindings = new Map<number, string[]>();
    const slicePlanes: CompositionPlan["bindings"]["slicePlanes"] = [];
    const bind = (channelIndex: number, layerId: string): void => {
      const list = channelBindings.get(channelIndex) ?? [];
      list.push(layerId);
      channelBindings.set(channelIndex, list);
    };

    for (const plane of PLANES) {
      const configs = buildImageLayers(primary, {
        view: "slice", prefix: plane.id, axes: plane.axes, channels, transform,
      });
      const layerIds = configs.map((layer) => layer.id);
      layers.push(...configs);
      views[plane.id] = { type: "slice", layers: layerIds };
      slicePlanes.push({ viewId: plane.id, layerIds, axes: resolveAxes(plane.axes) as AxisMap });
      configs.forEach((layer, slot) => bind(channels[slot].index, layer.id));
    }

    const volumeLayers = buildImageLayers(primary, {
      view: "volume", prefix: VOLUME_VIEW_ID, channels, projection, transform,
    });
    layers.push(...volumeLayers);
    views[VOLUME_VIEW_ID] = { type: "volume", layers: volumeLayers.map((layer) => layer.id) };
    volumeLayers.forEach((layer, slot) => bind(channels[slot].index, layer.id));

    return {
      layers,
      views,
      activeViewId : PLANES[0].id,
      layout       : { kind: "quad" },
      bindings     : {
        channels         : channelBindings,
        projectionLayers : volumeLayers.map((layer) => layer.id),
        slicePlanes,
      },
    };
  },
};
