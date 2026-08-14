/**
 * Dtype packing tests: normalization scale/offset per dtype, 3D tile packing
 * with zero padding, and equivalence of the two historical code paths
 * (uint8 LUT vs scale/offset).
 */
import { describe, expect, it } from "vitest";
import { dtypeNormalization, floatToFloat16, makeFloat16Encoder } from "../src/index";
import { packPlaneToFloat16, toFloat16 } from "../src/dataset/ome-zarr";

describe("dtypeNormalization", () => {
  it("maps integer dtype ranges onto [0, 1]", () => {
    expect(dtypeNormalization("uint8")).toEqual({ scale: 1 / 255, offset: 0 });
    expect(dtypeNormalization("|u1")).toEqual({ scale: 1 / 255, offset: 0 });
    expect(dtypeNormalization("uint16")).toEqual({ scale: 1 / 65535, offset: 0 });
    expect(dtypeNormalization("<u2")).toEqual({ scale: 1 / 65535, offset: 0 });
    expect(dtypeNormalization("int8")).toEqual({ scale: 1 / 255, offset: 128 });
    expect(dtypeNormalization("int16")).toEqual({ scale: 1 / 65535, offset: 32768 });
    expect(dtypeNormalization("<i2")).toEqual({ scale: 1 / 65535, offset: 32768 });
  });

  it("passes float and unknown dtypes through unchanged", () => {
    expect(dtypeNormalization("float32")).toEqual({ scale: 1, offset: 0 });
    expect(dtypeNormalization("<f4")).toEqual({ scale: 1, offset: 0 });
    expect(dtypeNormalization("complex64")).toEqual({ scale: 1, offset: 0 });
  });
});

describe("makeFloat16Encoder", () => {
  it("encodes uint8 exactly like the historical 256-entry LUT", () => {
    const lut = new Uint16Array(256);
    for (let i = 0; i < 256; i++) lut[i] = floatToFloat16(i / 255);
    const encode = makeFloat16Encoder("uint8");
    for (let i = 0; i < 256; i++) expect(encode(i)).toBe(lut[i]);
  });

  it("maps dtype min/max to 0 and 1", () => {
    expect(makeFloat16Encoder("uint8")(0)).toBe(0x0000);
    expect(makeFloat16Encoder("uint8")(255)).toBe(0x3c00);
    expect(makeFloat16Encoder("uint16")(0)).toBe(0x0000);
    expect(makeFloat16Encoder("uint16")(65535)).toBe(0x3c00);
    expect(makeFloat16Encoder("int8")(-128)).toBe(0x0000);
    expect(makeFloat16Encoder("int8")(127)).toBe(0x3c00);
    expect(makeFloat16Encoder("int16")(-32768)).toBe(0x0000);
    expect(makeFloat16Encoder("int16")(32767)).toBe(0x3c00);
  });

  it("passes float values through the half conversion", () => {
    expect(makeFloat16Encoder("float32")(0.5)).toBe(0x3800);
    expect(makeFloat16Encoder("float32")(1)).toBe(0x3c00);
  });
});

describe("toFloat16", () => {
  it("packs a full uint8 tile x-fastest", () => {
    const packed = toFloat16(
      new Uint8Array([0, 255, 128, 64]),
      "uint8",
      [2, 2, 1],
      [2, 2, 1],
    );
    expect([...new Uint16Array(packed)]).toEqual([
      0x0000, 0x3c00,
      floatToFloat16(128 / 255), floatToFloat16(64 / 255),
    ]);
  });

  it("zero-pads the region outside validShape", () => {
    // 4x2 tile, only the left column (x = 0) valid on both rows
    const packed = toFloat16(
      new Uint8Array([255, 255]),
      "uint8",
      [4, 2, 1],
      [1, 2, 1],
    );
    expect([...new Uint16Array(packed)]).toEqual([
      0x3c00, 0, 0, 0,
      0x3c00, 0, 0, 0,
    ]);
  });

  it("clamps when data is shorter than the valid region", () => {
    const packed = toFloat16(new Uint8Array([255]), "uint8", [2, 2, 1], [2, 2, 1]);
    expect([...new Uint16Array(packed)]).toEqual([0x3c00, 0, 0, 0]);
  });

  it("normalizes signed integer dtypes", () => {
    const packed = toFloat16(new Int8Array([-128, 0, 127, 1]), "int8", [4, 1, 1], [4, 1, 1]);
    expect([...new Uint16Array(packed)]).toEqual([
      0x0000,
      floatToFloat16(128 / 255),
      0x3c00,
      floatToFloat16(129 / 255),
    ]);
  });

  it("packs uint16 with 1/65535 scaling", () => {
    const packed = toFloat16(new Uint16Array([0, 65535]), "uint16", [2, 1, 1], [2, 1, 1]);
    expect([...new Uint16Array(packed)]).toEqual([0x0000, 0x3c00]);
  });

  it("pads whole empty depth slices with zeros", () => {
    const packed = toFloat16(
      new Uint8Array([255, 255, 255, 255]),
      "uint8",
      [2, 2, 2],
      [2, 2, 1],
    );
    const words = new Uint16Array(packed);
    expect([...words.slice(0, 4)]).toEqual([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
    expect([...words.slice(4)]).toEqual([0, 0, 0, 0]);
  });
});

describe("packPlaneToFloat16", () => {
  it("shares the dtype encoding with toFloat16", () => {
    // natural axis order (resultAxes [v, u]): no transpose
    const plane = packPlaneToFloat16(
      new Int16Array([-32768, 32767, 0, 1]),
      "int16",
      [2, 2, 1],
      [2, 2, 1],
      [0, 1, 2],
      [1, 0],
    );
    expect([...new Uint16Array(plane)]).toEqual([
      0x0000, 0x3c00,
      floatToFloat16(32768 / 65535), floatToFloat16(32769 / 65535),
    ]);
  });

  it("zero-pads rows beyond the valid region", () => {
    const plane = packPlaneToFloat16(
      new Uint8Array([255]),
      "uint8",
      [2, 2, 1],
      [1, 1, 1],
      [0, 1, 2],
      [1, 0],
    );
    expect([...new Uint16Array(plane)]).toEqual([0x3c00, 0, 0, 0]);
  });
});
