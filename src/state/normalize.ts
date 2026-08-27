/**
 * Live-scene normalization for the runtime state authority: camera
 * constraints, layer render defaults, deep-copied physical space. These operate on LIVE states — runtime bindings
 * (`Data.fetch`, parsed `Data.geometry`) pass through untouched; portability
 * is enforced separately by `validateState` (see `./schema`).
 *
 * The DEFAULT_* constants live in `../defaults` (shared defaults module);
 * this sibling file exists so `schema.ts` itself can stay import-free.
 */

import {
  DEFAULT_CAMERA_NAV_MODE,
  DEFAULT_CAMERA_PROJ_MODE,
  DEFAULT_EXPLORATION,
  DEFAULT_STATE,
} from "../defaults";
import type {
  ChannelState,
  Exploration,
  LayerConfig,
  PhysicalSpace,
  State,
  Vec3,
} from "./schema";

function normalizeExploration(exploration: Exploration): Exploration {
  const cam = exploration.camera;
  return {
    camera: {
      navMode   : cam.navMode ?? DEFAULT_CAMERA_NAV_MODE,
      projMode  : cam.projMode ?? DEFAULT_CAMERA_PROJ_MODE,
      position  : [...cam.position] as Vec3,
      target    : [...cam.target] as Vec3,
      up        : cam.up ? ([...cam.up] as Vec3) : undefined,
    },
    temporal: exploration.temporal ? { ...exploration.temporal } : undefined,
  };
}

function normalizeLayers(layers: LayerConfig[]): LayerConfig[] {
  return layers.map((l) => {
    const render = l.render ? { ...l.render } : {};
    if (render.visible === undefined) render.visible = true;
    return { ...l, render };
  });
}

export function normalizePhysicalSpace(physical?: PhysicalSpace): PhysicalSpace | undefined {
  if (!physical) return undefined;
  return {
    ...physical,
    spatial: {
      ...physical.spatial,
      size      : [...physical.spatial.size] as Vec3,
      spacing   : physical.spatial.spacing ? [...physical.spatial.spacing] as Vec3 : undefined,
      origin    : physical.spatial.origin ? [...physical.spatial.origin] as Vec3 : undefined,
      transform : physical.spatial.transform ? [...physical.spatial.transform] : undefined,
    },
  };
}

/**
 * Normalize full state — camera constraints, layer defaults, deep-copy
 * physical. The unified facade sections (`composition`/`channels`/
 * `projection`/`tools`/`compositions`) pass through with a shallow clone.
 *
 * `layers` is optional on the document (facade viewers omit it); the live
 * scene this normalizes for is layer-driven, so a missing list normalizes to
 * an empty one.
 */
export function normalizeState(state: State): State & { layers: LayerConfig[] } {
  const out: State & { layers: LayerConfig[] } = {
    exploration : normalizeExploration(state.exploration),
    layers      : normalizeLayers(state.layers ?? []),
    physical    : normalizePhysicalSpace(state.physical),
  };
  if (state.composition !== undefined) {
    out.composition = {
      ...state.composition,
      ...(state.composition.config ? { config: { ...state.composition.config } } : {}),
    };
  }
  if (state.channels !== undefined) {
    out.channels = state.channels.map((channel): ChannelState => ({
      ...channel,
      contrast: [...channel.contrast] as [number, number],
    }));
  }
  if (state.projection !== undefined) out.projection = state.projection;
  if (state.tools !== undefined) out.tools = { ...state.tools };
  if (state.compositions !== undefined) out.compositions = { ...state.compositions };
  return out;
}

export function normalizeInitialState(state: State): State & { layers: LayerConfig[] } {
  return normalizeState({
    ...DEFAULT_STATE,
    ...state,
    exploration: {
      ...DEFAULT_EXPLORATION,
      ...state.exploration,
      camera: {
        ...DEFAULT_EXPLORATION.camera,
        ...state.exploration.camera,
      },
    },
  });
}
