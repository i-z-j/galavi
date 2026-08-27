/**
 * MeshDataset — the `"mesh"` dataset kind: a single OBJ mesh.
 *
 * `load()` fetches and parses the OBJ once: the parse derives the dataset
 * metadata (physical space from the mesh AABB, so the facade's camera fit
 * frames the mesh) and is retained on the primary `"mesh"` resource as
 * pre-parsed geometry — one network request and one parse per open.
 * Compositions hand the geometry to surface-style layers as `Data.geometry`
 * (defensively copied), so a generated layer never fetches the URL itself.
 *
 * Registered by the idempotent `ensureBuiltInDatasets()` bootstrap
 * (dataset/index.ts), invoked by `openDataset` — not on module load — so the
 * core entry stays free of import side effects; `"mesh"` is always
 * available through the core entry's open path.
 *
 * The OBJ parser ({@link parseOBJ}) belongs to this adapter: the
 * `SurfaceGeometry`/`AABB` types it produces live in `state/schema.ts`;
 * surface-style layers import the parser from here.
 */

import type { SurfaceGeometry, Vec3 } from "../../state/schema";
import { aabbFromPositions } from "../../utils";
import { Dataset, type DatasetConfigMap } from "../contract";

/**
 * Parse Wavefront OBJ text into a {@link SurfaceGeometry}: triangle-soup
 * positions (quads fan-triangulated), optional per-vertex normals and UVs.
 * Unknown statements are ignored.
 */
export function parseOBJ(objText: string): SurfaceGeometry {
  const positions : number[] = [];
  const normals   : number[] = [];
  const uvs       : number[] = [];

  const vertexPositions : Vec3[] = [];
  const vertexNormals   : Vec3[] = [];
  const vertexUVs       : [number, number][] = [];

  const lines = objText.split("\n");

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case "v": // Vertex position
        vertexPositions.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
        break;

      case "vn": // Vertex normal
        vertexNormals.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
        break;

      case "vt": // Texture coordinate
        vertexUVs.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
        ]);
        break;

      case "f": // Face
        // Handle triangles and quads
        const vertices = parts.slice(1);
        const triangleIndices = triangulate(vertices.length);

        for (const idx of triangleIndices) {
          const vertex = vertices[idx];
          const [vIdx, vtIdx, vnIdx] = parseVertexIndex(vertex);

          if (vIdx !== undefined && vertexPositions[vIdx]) {
            positions.push(...vertexPositions[vIdx]);
          }
          if (vnIdx !== undefined && vertexNormals[vnIdx]) {
            normals.push(...vertexNormals[vnIdx]);
          }
          if (vtIdx !== undefined && vertexUVs[vtIdx]) {
            uvs.push(...vertexUVs[vtIdx]);
          }
        }
        break;
    }
  }

  return {
    positions   : new Float32Array(positions),
    normals     : normals.length > 0 ? new Float32Array(normals) : undefined,
    uvs         : uvs.length > 0 ? new Float32Array(uvs) : undefined,
    vertexCount : positions.length / 3,
  };
}

function parseVertexIndex(vertex: string): [number?, number?, number?] {
  const parts = vertex.split("/");
  const vIdx  = parts[0] ? parseInt(parts[0]) - 1 : undefined;
  const vtIdx = parts[1] ? parseInt(parts[1]) - 1 : undefined;
  const vnIdx = parts[2] ? parseInt(parts[2]) - 1 : undefined;
  return [vIdx, vtIdx, vnIdx];
}

function triangulate(vertexCount: number): number[] {
  // Convert polygon to triangles (fan triangulation)
  const indices: number[] = [];
  for (let i = 1; i < vertexCount - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return indices;
}

/**
 * Named descriptor for the built-in `"mesh"` dataset kind — the declarative
 * config for one OBJ mesh, for `ViewerConfig.dataset` / `openDataset`:
 *
 * ```ts
 * import { createViewer, mesh } from "galavi";
 * const viewer = await createViewer("#app", { dataset: mesh("https://server/mesh.obj") });
 * ```
 *
 * The return is plain JSON — exactly `{ type: "mesh", source }`, the
 * `DatasetConfigMap["mesh"]` member — so it round-trips through
 * `JSON.parse(JSON.stringify(...))` unchanged and never carries runtime
 * resources (the fetch happens later, inside `load()`). The `"mesh"` loader
 * is a lazy built-in of the core entry (no side-effect import needed), which
 * is why this helper lives on the root `galavi` entry — unlike format
 * subpath helpers such as `omeZarr` from `galavi/ome-zarr`, whose import
 * performs that kind's registration.
 */
export function mesh(source: string): DatasetConfigMap["mesh"] {
  return { type: "mesh", source };
}

export class MeshDataset extends Dataset {
  /**
   * Parsed geometry from `load()`, exposed through the primary `"mesh"`
   * resource; released on dispose.
   */
  private geometry?: SurfaceGeometry;

  override async load(): Promise<void> {
    const config = this.config;
    if (config.type !== "mesh") {
      throw new Error(`MeshDataset cannot load config of type ${JSON.stringify(config.type)}`);
    }
    const source: unknown = config.source;
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
    this.resources = [{ id: "mesh", kind: "mesh", source, geometry: this.geometry }];
    this.primaryResourceId = "mesh";
  }

  override dispose(): void {
    this.geometry = undefined;
    this.primaryResourceId = undefined;
    this.resources = [];
  }
}
