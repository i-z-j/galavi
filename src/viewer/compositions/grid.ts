/**
 * Grid reference composition — a paged pool of slice views (the contact-sheet
 * composition).
 *
 * The composition stays PURE and config-driven: `build()` returns a plan with
 * `layout: { kind: "grid", pool }`, one slice view per pool cell, and one
 * additive slice layer per cell per channel. The Viewer owns the pool DOM,
 * paging, and batched updates — a page turn re-builds the plan and applies it
 * as ONE batched layer transaction (`viewer.setCompositionConfig`).
 *
 * Portable config (`State.composition.config` / `setCompositionConfig`):
 *
 * - `pool?: number` — pool size (default {@link DEFAULT_GRID_POOL}). A pool
 *   change rebuilds the scene (layer/view counts change).
 * - `page?: number` — zero-based page; cell `i` shows slice `page * pool + i`
 *   along the through-plane axis (z), with the out-of-range tail hidden.
 * - `slices?: (number | null)[]` — explicit per-cell slice indices; takes
 *   precedence over `page`. `null` hides the cell. When present its length IS
 *   the pool size (`pool` must agree when both are given).
 *
 * Slice positions are config-driven, not focus-driven: the plan contributes no
 * slice-plane bindings, so camera-target sync does not move grid slices.
 */

import type { JsonObject, LayerConfig } from "../../state/schema";
import {
  buildImageLayers,
  primaryResourceOf,
  unsupportedPrimary,
  type CompositionPlan,
  type CompositionViewConfig,
  type ViewerComposition,
} from "../contract";

/** Default pool size when neither `pool` nor `slices` pins it. */
export const DEFAULT_GRID_POOL = 6;

/** The normalized grid composition config (JSON-safe; `null` hides a cell). */
export interface GridCompositionConfig {
  pool   : number;
  page   : number;
  slices?: (number | null)[];
}

function configProblem(message: string): Error {
  return new Error(`grid composition config: ${message}`);
}

function readPool(value: unknown, slices: unknown): number {
  if (value === undefined) {
    return Array.isArray(slices) ? slices.length : DEFAULT_GRID_POOL;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw configProblem(`pool must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function readPage(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw configProblem(`page must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function readSlices(value: unknown, pool: number): (number | null)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw configProblem(`slices must be an array of non-negative integers or null, got ${JSON.stringify(value)}`);
  }
  if (value.length !== pool) {
    throw configProblem(
      `slices has ${value.length} entries but the pool size is ${pool} — ` +
      "slices.length IS the pool size (drop `pool` or make them agree)",
    );
  }
  return value.map((entry, i) => {
    if (entry === null) return null;
    if (!Number.isInteger(entry) || (entry as number) < 0) {
      throw configProblem(
        `slices[${i}] must be a non-negative integer or null (hidden cell) — got ${JSON.stringify(entry)}`,
      );
    }
    return entry as number;
  });
}

/** View id of pool cell `index` (deterministic). */
export function gridCellViewId(index: number): string {
  return `grid-cell-${index}`;
}

/** Layer id of pool cell `index`, channel `channelIndex` (deterministic). */
export function gridCellLayerId(index: number, channelIndex: number): string {
  return `grid-cell-${index}-c${channelIndex}`;
}

export const gridComposition: ViewerComposition = {
  type: "grid",

  supports(dataset) {
    const primary = primaryResourceOf(dataset);
    return primary?.kind === "image-pyramid" && primary.pyramid.levels.length > 0;
  },

  build({ dataset, channels, transform, config }): CompositionPlan {
    const primary = primaryResourceOf(dataset);
    if (primary?.kind !== "image-pyramid") throw unsupportedPrimary("grid", dataset);
    if (primary.pyramid.levels.length === 0) {
      throw new Error(
        `composition "grid" cannot build a scene for dataset kind "${dataset.type}": ` +
        `primary resource "${primary.id}" has an empty pyramid (no levels)`,
      );
    }
    if (channels.length === 0) {
      throw new Error(
        'composition "grid" needs at least one channel — the dataset reports none',
      );
    }

    const pool   = readPool(config?.pool, config?.slices);
    const page   = readPage(config?.page);
    const slices = readSlices(config?.slices, pool);

    // Page-derived slices hide the out-of-range tail; explicit slices are
    // used as given (the layer clamps to its own range).
    const sliceCount = primary.pyramid.levels[0].shape[2];
    const sliceAt = (cell: number): number | undefined => {
      if (slices) return slices[cell] ?? undefined;
      const value = page * pool + cell;
      return value < sliceCount ? value : undefined;
    };

    // selection.c is meaningful only when the source store actually has a c
    // axis — mirror the resource's defaults otherwise (a stray key is ignored
    // by the layer but would misrepresent the selection in runtime state).
    const hasChannelAxis = primary.dimensions.some((dim) => dim.name === "c");

    const layers: LayerConfig[] = [];
    const views: Record<string, CompositionViewConfig> = {};
    const channelBindings = new Map<number, string[]>();
    for (let cell = 0; cell < pool; cell++) {
      const slice = sliceAt(cell);
      const cellLayers = buildImageLayers(primary, {
        view: "slice", prefix: gridCellViewId(cell), axes: ["x", "y"], channels, transform,
      });
      const layerIds: string[] = [];
      cellLayers.forEach((layer, slot) => {
        const channel = channels[slot];
        const options: Record<string, unknown> = {
          ...(layer.options as Record<string, unknown>),
          sliceIndex: slice ?? 0,
        };
        if (!hasChannelAxis) {
          const selection = { ...(options.selection as Record<string, number>) };
          delete selection.c;
          options.selection = selection;
        }
        layer.options = options;
        layer.render = {
          ...layer.render,
          // A hidden cell suppresses every channel of the cell; re-showing the
          // cell restores each channel's own configured visibility.
          visible: slice !== undefined && channel.visible,
        };
        layerIds.push(layer.id);
        const list = channelBindings.get(channel.index) ?? [];
        list.push(layer.id);
        channelBindings.set(channel.index, list);
      });
      layers.push(...cellLayers);
      views[gridCellViewId(cell)] = {
        type        : "slice",
        layers      : layerIds,
        // Grid cells are non-interactive (the app pages; nobody focuses a cell).
        activatable : false,
      };
    }

    const normalized: GridCompositionConfig = { pool, page };
    if (slices) normalized.slices = slices;

    return {
      layers,
      views,
      activeViewId : gridCellViewId(0),
      layout       : { kind: "grid", pool },
      bindings     : {
        channels         : channelBindings,
        projectionLayers : [],
        // Config-driven slice positions: no focus-driven slice planes.
        slicePlanes      : [],
      },
      config: normalized as unknown as JsonObject,
    };
  },
};
