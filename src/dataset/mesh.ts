/**
 * MeshDataset — the `"mesh"` dataset kind: a single OBJ mesh.
 *
 * `load()` fetches and parses the OBJ once: the parse derives the dataset
 * metadata (physical space from the mesh AABB, so the facade's camera fit
 * frames the mesh) and is then HANDED to the default surface layer as
 * pre-parsed `Data.geometry` — one network request and one parse per open
 * (ARCH-1); the layer never fetches the URL itself.
 *
 * A mesh is a volume-only presentation: the surface layer is meaningful in a
 * 3D view, so capabilities advertise exactly `{ modes: ["volume"] }`.
 *
 * Registered as a LAZY built-in of `datasetRegistry` (registry.ts) on first
 * registry access — not on module load — so the core entry stays free of
 * import side effects (API-6); `"mesh"` is always registered through the
 * core entry.
 */

import { parseOBJ, type SurfaceGeometry } from "../layer/surface/main";
import type { Data, LayerConfig } from "../types";
import { aabbFromPositions } from "../utils";
import {
  Dataset,
  type DefaultLayersOptions,
} from "./base";

export class MeshDataset extends Dataset {
  /**
   * Parsed geometry from `load()`, retained for the default-layer handoff;
   * released on dispose.
   */
  private geometry?: SurfaceGeometry;

  override async load(): Promise<void> {
    const source: unknown = this.config.source;
    if (typeof source !== "string" || source.length === 0) {
      throw new Error(
        `MeshDataset requires a "source" URL string, got: ${JSON.stringify(source)}`,
      );
    }
    const resp = await fetch(source);
    if (!resp.ok) throw new Error(`Mesh fetch failed: ${resp.status} (${source})`);
    this.geometry = parseOBJ(await resp.text());

    // Physical space = the mesh AABB, so the facade's camera fit frames it.
    const { min, max } = aabbFromPositions(this.geometry.positions);
    this.physical = {
      spatial: {
        size   : [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        origin : [...min],
      },
    };
    this.capabilities = { modes: ["volume"], defaultMode: "volume" };
  }

  override dispose(): void {
    this.geometry = undefined;
  }

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    // Hand the already-parsed geometry to the surface layer (ARCH-1). The
    // layer normalizes positions in place, so each hand-off carries a copy —
    // scene rebuilds call this method again on the same dataset.
    const data: Data = { url: this.config.source };
    if (this.geometry) data.geometry = cloneGeometry(this.geometry);
    return [{
      id      : `${options.prefix}-mesh`,
      type    : "surface",
      data,
      options : { fitToUnitAABB: true },
    }];
  }
}

/** Defensive copy for the layer handoff — surface normalization mutates positions. */
function cloneGeometry(geometry: SurfaceGeometry): SurfaceGeometry {
  return {
    ...geometry,
    positions : geometry.positions.slice(),
    normals   : geometry.normals?.slice(),
    uvs       : geometry.uvs?.slice(),
    indices   : geometry.indices?.slice(),
  };
}
