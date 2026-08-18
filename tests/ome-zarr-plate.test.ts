/**
 * openOMEZarrPlate tests — typed OME-Zarr HCS (plate) metadata.
 *
 * Runs against deterministic in-memory plate/well metadata stores served
 * through a stubbed global fetch (no network): OME-Zarr v0.5 (Zarr v3,
 * `ome.plate`/`ome.well` attrs) and v0.4 (Zarr v2, `plate`/`well` attrs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOMEZarrPlate } from "../src/dataset/ome-zarr";

const encoder = new TextEncoder();

function v3GroupJson(attributes: Record<string, unknown>): string {
  return JSON.stringify({ zarr_format: 3, node_type: "group", attributes });
}

/** Stub fetch: keys are paths relative to the base URL; anything else 404s. */
function stubPlateFetch(baseUrl: string, routes: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input).slice(baseUrl.length + 1); // after "<base>/"
    const body = routes[path];
    if (body !== undefined) return new Response(encoder.encode(body), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

// --- OME-Zarr v0.5 fixture: 2 rows x 2 columns, wells A/1 (2 fields) and B/2 (1 field) ---

const V5_BASE = "https://example.test/plate-v5.zarr";

const V5_ROUTES: Record<string, string> = {
  "zarr.json": v3GroupJson({
    ome: {
      version: "0.5",
      plate: {
        name       : "Test plate",
        rows       : [{ name: "A" }, { name: "B" }],
        columns    : [{ name: "1" }, { name: "2" }],
        wells      : [
          { path: "A/1", rowIndex: 0, columnIndex: 0 },
          { path: "B/2", rowIndex: 1, columnIndex: 1 },
        ],
        acquisitions: [{ id: 0, name: "acq-0" }],
      },
    },
  }),
  "A/1/zarr.json": v3GroupJson({
    ome: {
      version: "0.5",
      well   : { images: [{ path: "0", acquisition: 0 }, { path: "1", acquisition: 0 }] },
    },
  }),
  "B/2/zarr.json": v3GroupJson({
    ome: {
      version: "0.5",
      well   : { images: [{ path: "0" }] },
    },
  }),
};

// --- OME-Zarr v0.4 fixture: same layout, v2 group/attrs keys ---

const V4_BASE = "https://example.test/plate-v4.zarr";

const V4_ROUTES: Record<string, string> = {
  ".zgroup": JSON.stringify({ zarr_format: 2 }),
  ".zattrs": JSON.stringify({
    plate: {
      version: "0.4",
      name   : "Legacy plate",
      rows   : [{ name: "A" }, { name: "B" }],
      columns: [{ name: "1" }, { name: "2" }],
      wells  : [{ path: "A/1", rowIndex: 0, columnIndex: 0 }],
    },
  }),
  "A/1/.zgroup": JSON.stringify({ zarr_format: 2 }),
  "A/1/.zattrs": JSON.stringify({
    well: { version: "0.4", images: [{ path: "0" }, { path: "1" }, { path: "2" }] },
  }),
};

describe("openOMEZarrPlate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("v0.5 (Zarr v3)", () => {
    beforeEach(() => stubPlateFetch(V5_BASE, V5_ROUTES));

    it("enumerates wells with row/column identity and paths", async () => {
      const plate = await openOMEZarrPlate(V5_BASE);
      expect(plate.omeVersion).toBe("0.5");
      expect(plate.name).toBe("Test plate");
      expect(plate.rows).toEqual(["A", "B"]);
      expect(plate.columns).toEqual(["1", "2"]);
      expect(plate.acquisitions).toEqual([{ id: 0, name: "acq-0" }]);
      expect(plate.wells).toHaveLength(2);
      expect(plate.wells[0]).toMatchObject({
        path: "A/1", rowIndex: 0, columnIndex: 0, row: "A", column: "1",
      });
      expect(plate.wells[1]).toMatchObject({
        path: "B/2", rowIndex: 1, columnIndex: 1, row: "B", column: "2",
      });
    });

    it("derives field counts from well.images (no hard-coded fallback)", async () => {
      const plate = await openOMEZarrPlate(V5_BASE);
      expect(plate.wells[0].fields).toHaveLength(2);
      expect(plate.wells[1].fields).toHaveLength(1);
      expect(plate.wells[0].fields.map((f) => f.index)).toEqual([0, 1]);
      expect(plate.wells[0].fields[0].acquisition).toBe(0);
      expect(plate.wells[1].fields[0].acquisition).toBeUndefined();
    });

    it("builds DatasetConfig-compatible child references per field", async () => {
      const plate = await openOMEZarrPlate(V5_BASE);
      expect(plate.wells[0].fields.map((f) => f.source)).toEqual([
        { type: "ome-zarr", source: `${V5_BASE}/A/1/0` },
        { type: "ome-zarr", source: `${V5_BASE}/A/1/1` },
      ]);
      expect(plate.wells[1].fields[0].source)
        .toEqual({ type: "ome-zarr", source: `${V5_BASE}/B/2/0` });
      // Descriptors must survive JSON round-trip (galavi DatasetConfig contract).
      expect(JSON.parse(JSON.stringify(plate.wells[0].fields[0].source)))
        .toEqual(plate.wells[0].fields[0].source);
    });
  });

  describe("v0.4 (Zarr v2)", () => {
    beforeEach(() => stubPlateFetch(V4_BASE, V4_ROUTES));

    it("reads top-level plate/well attrs and derives fields from well.images", async () => {
      const plate = await openOMEZarrPlate(V4_BASE);
      expect(plate.omeVersion).toBe("0.4");
      expect(plate.name).toBe("Legacy plate");
      expect(plate.wells).toHaveLength(1);
      expect(plate.wells[0]).toMatchObject({ path: "A/1", row: "A", column: "1" });
      expect(plate.wells[0].fields).toHaveLength(3);
      expect(plate.wells[0].fields[2].source)
        .toEqual({ type: "ome-zarr", source: `${V4_BASE}/A/1/2` });
    });
  });

  describe("errors", () => {
    it("rejects a non-plate store (multiscales group without plate metadata)", async () => {
      const base = "https://example.test/not-a-plate.zarr";
      stubPlateFetch(base, {
        "zarr.json": v3GroupJson({
          ome: { version: "0.5", multiscales: [{ axes: [], datasets: [] }] },
        }),
      });
      await expect(openOMEZarrPlate(base)).rejects.toThrow(/not an OME-Zarr HCS plate/);
    });

    it("rejects when a well group is missing", async () => {
      const base = "https://example.test/missing-well.zarr";
      stubPlateFetch(base, {
        "zarr.json": v3GroupJson({
          ome: {
            version: "0.5",
            plate  : {
              rows: [{ name: "A" }], columns: [{ name: "1" }],
              wells: [{ path: "A/1", rowIndex: 0, columnIndex: 0 }],
            },
          },
        }),
        // no "A/1/zarr.json" route → well open 404s
      });
      await expect(openOMEZarrPlate(base)).rejects.toThrow(/Failed to open well group "A\/1"/);
    });

    it("rejects when a well group has no well metadata with images", async () => {
      const base = "https://example.test/empty-well.zarr";
      stubPlateFetch(base, {
        "zarr.json": v3GroupJson({
          ome: {
            version: "0.5",
            plate  : {
              rows: [{ name: "A" }], columns: [{ name: "1" }],
              wells: [{ path: "A/1", rowIndex: 0, columnIndex: 0 }],
            },
          },
        }),
        "A/1/zarr.json": v3GroupJson({ ome: { version: "0.5" } }),
      });
      await expect(openOMEZarrPlate(base))
        .rejects.toThrow(/Well "A\/1" has no OME well metadata with images/);
    });

    it("rejects an unsupported OME-Zarr version", async () => {
      const base = "https://example.test/unsupported.zarr";
      stubPlateFetch(base, {
        "zarr.json": v3GroupJson({
          ome: {
            version: "0.3",
            plate  : {
              rows: [{ name: "A" }], columns: [{ name: "1" }],
              wells: [{ path: "A/1", rowIndex: 0, columnIndex: 0 }],
            },
          },
        }),
      });
      await expect(openOMEZarrPlate(base))
        .rejects.toThrow(/Unsupported OME-Zarr version "0\.3"/);
    });

    it("rejects a well referencing out-of-range row/column indices", async () => {
      const base = "https://example.test/bad-well-ref.zarr";
      stubPlateFetch(base, {
        "zarr.json": v3GroupJson({
          ome: {
            version: "0.5",
            plate  : {
              rows: [{ name: "A" }], columns: [{ name: "1" }],
              wells: [{ path: "A/9", rowIndex: 0, columnIndex: 9 }],
            },
          },
        }),
      });
      await expect(openOMEZarrPlate(base))
        .rejects.toThrow(/references row 0, column 9/);
    });

    it("surfaces network failures with URL context", async () => {
      vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
      await expect(openOMEZarrPlate("https://example.test/down.zarr"))
        .rejects.toThrow(/Failed to open OME-Zarr plate store at "https:\/\/example\.test\/down\.zarr"/);
    });
  });
});
