/**
 * MeshDataset — the `"mesh"` dataset kind: a single OBJ mesh.
 *
 * `load()` fetches and parses the OBJ once to derive the dataset metadata
 * (physical space from the mesh AABB, so the facade's camera fit frames the
 * mesh). The default layer is a plain surface layer pointed at the same URL
 * — it fetches/parses the OBJ itself, exactly as surface layers always have.
 *
 * Self-registers on module load; `src/dataset/index.ts` imports this module,
 * so `"mesh"` is always registered through the core entry.
 */

import { parseOBJ, type SurfaceGeometry } from "../layer/surface/main";
import { registerDataset } from "../registry";
import type { LayerConfig } from "../types";
import { aabbFromPositions } from "../utils";
import {
  Dataset,
  type DatasetDefaults,
  type DefaultLayersOptions,
} from "./base";

export class MeshDataset extends Dataset {
  /** Parsed geometry, held for the AABB/metadata; released on dispose. */
  private geometry?: SurfaceGeometry;

  override async load(): Promise<void> {
    const source = this.config.source;
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
    this.capabilities = { zDepth: 1, supports3D: true, supportsVolumePreview: true };
  }

  override dispose(): void {
    this.geometry = undefined;
  }

  override deriveDefaults(): DatasetDefaults {
    return { mode: "volume", selection: {} };
  }

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    // The surface layer fetches/parses the OBJ itself (unchanged behavior);
    // fitToUnitAABB centers it in the physical frame derived from the AABB.
    return [{
      id      : `${options.prefix}-mesh`,
      type    : "surface",
      data    : { url: this.config.source as string },
      options : { fitToUnitAABB: true },
    }];
  }
}

registerDataset("mesh", (config) => new MeshDataset(config));
