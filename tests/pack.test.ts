/**
 * Dtype packing tests: normalization scale/offset per dtype and float16
 * encoding of raw samples (uint8 LUT equivalence, signed offsets, zero
 * padding). Ported from the OME-Zarr adapter's pack tests — the helpers now
 * live in galavi as shared tile-source machinery.
 */
import { describe, expect, it } from "vitest";
import { dtypeNormalization, floatToFloat16, makeFloat16Encoder } from "../src/index";

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

  it("normalizes signed integer samples around zero", () => {
    expect(makeFloat16Encoder("int8")(0)).toBe(floatToFloat16(128 / 255));
    expect(makeFloat16Encoder("int8")(1)).toBe(floatToFloat16(129 / 255));
    expect(makeFloat16Encoder("int16")(0)).toBe(floatToFloat16(32768 / 65535));
    expect(makeFloat16Encoder("int16")(1)).toBe(floatToFloat16(32769 / 65535));
  });

  it("passes float values through the half conversion", () => {
    expect(makeFloat16Encoder("float32")(0.5)).toBe(0x3800);
    expect(makeFloat16Encoder("float32")(1)).toBe(0x3c00);
  });

  it("encodes zero-filled padding as 0x0000 for integer dtypes", () => {
    // Tile buffers are zero-filled outside the valid region; raw zeros must
    // stay zero after encoding so padding reads as the dtype minimum.
    expect(makeFloat16Encoder("uint8")(0)).toBe(0x0000);
    expect(makeFloat16Encoder("uint16")(0)).toBe(0x0000);
    expect(makeFloat16Encoder("float32")(0)).toBe(0x0000);
  });
});
