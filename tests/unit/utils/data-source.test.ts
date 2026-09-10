import { describe, expect, test } from "vitest";
import type { Data, ImagePyramid, SurfaceGeometry } from "../../../src/state/schema";
import { resolveDataUrl, dataSourceChanged } from "../../../src/utils/data-source";

const pyramidA: ImagePyramid = {
  levels: [
    { path: "0", shape: [256, 256, 1], chunkSize: [256, 256, 1], scale: [1, 1, 1] },
  ],
};

const geometryA: SurfaceGeometry = {
  positions   : new Float32Array([0, 0, 0]),
  vertexCount : 1,
};

describe("resolveDataUrl", () => {
  test("passes a plain url through unchanged", () => {
    expect(resolveDataUrl({ url: "https://example.com/data.zarr" }))
      .toBe("https://example.com/data.zarr");
  });

  test("substitutes {url} and arbitrary {key} vars into urlTemplate", () => {
    const url = resolveDataUrl(
      {
        url         : "https://example.com/data.zarr",
        urlTemplate : "{url}:img3d:{level}:{c}:{z},{y},{x}",
      },
      { level: 1, c: 2, z: 3, y: 4, x: 5 },
    );
    expect(url).toBe("https://example.com/data.zarr:img3d:1:2:3,4,5");
  });

  test("stringifies numeric var values", () => {
    const url = resolveDataUrl(
      { urlTemplate: "tiles/{level}/{scale}" },
      { level: 0, scale: 0.5 },
    );
    expect(url).toBe("tiles/0/0.5");
  });

  test("skips vars with undefined values", () => {
    const url = resolveDataUrl(
      { urlTemplate: "{url}/{level}/{z}", url: "https://example.com" },
      { level: 1, z: undefined },
    );
    expect(url).toBe("https://example.com/1/{z}");
  });

  test("prefers urlTemplate over url when both are set", () => {
    const url = resolveDataUrl({
      url         : "https://example.com/plain",
      urlTemplate : "{url}/templated",
    });
    expect(url).toBe("https://example.com/plain/templated");
  });

  test("throws when neither url nor urlTemplate is set", () => {
    expect(() => resolveDataUrl({})).toThrow(
      "DataSource must have either url, urlTemplate, or fetch",
    );
  });
});

describe("dataSourceChanged", () => {
  const base: Data = { url: "https://example.com/a" };

  test("returns true when url differs", () => {
    expect(dataSourceChanged({ url: "https://example.com/b" }, base)).toBe(true);
  });

  test("returns true when urlTemplate differs", () => {
    expect(dataSourceChanged(
      { ...base, urlTemplate: "{url}/1" },
      { ...base, urlTemplate: "{url}/2" },
    )).toBe(true);
  });

  test("returns true when fetch identity differs", () => {
    const fetchA = async () => new ArrayBuffer(0);
    const fetchB = async () => new ArrayBuffer(0);
    expect(dataSourceChanged({ ...base, fetch: fetchA }, { ...base, fetch: fetchB })).toBe(true);
    expect(dataSourceChanged({ ...base, fetch: fetchA }, { ...base, fetch: fetchA })).toBe(false);
  });

  test("returns true when pyramid identity differs", () => {
    const pyramidB: ImagePyramid = { levels: [...pyramidA.levels] };
    expect(dataSourceChanged({ ...base, pyramid: pyramidA }, { ...base, pyramid: pyramidB })).toBe(true);
    expect(dataSourceChanged({ ...base, pyramid: pyramidA }, { ...base, pyramid: pyramidA })).toBe(false);
  });

  test("returns true when geometry identity differs", () => {
    const geometryB: SurfaceGeometry = {
      positions   : new Float32Array([0, 0, 0]),
      vertexCount : 1,
    };
    expect(dataSourceChanged({ ...base, geometry: geometryA }, { ...base, geometry: geometryB })).toBe(true);
    expect(dataSourceChanged({ ...base, geometry: geometryA }, { ...base, geometry: geometryA })).toBe(false);
  });

  test("returns false when only transform differs (transform is excluded)", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const shifted  = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    expect(dataSourceChanged({ ...base, transform: identity }, { ...base, transform: shifted })).toBe(false);
  });

  test("returns false for identical sources and undefined arguments", () => {
    expect(dataSourceChanged(base, { ...base })).toBe(false);
    expect(dataSourceChanged(undefined, undefined)).toBe(false);
  });

  test("returns true when only one side is undefined", () => {
    expect(dataSourceChanged(base, undefined)).toBe(true);
    expect(dataSourceChanged(undefined, base)).toBe(true);
  });
});
