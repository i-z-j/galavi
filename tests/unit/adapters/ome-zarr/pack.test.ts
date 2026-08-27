/**
 * OME-Zarr adapter tile packing: 3D tile packing with zero padding and
 * axis-order-aware plane packing. The generic dtype normalization / float16
 * encoding cases live in tests/unit/helpers/packing.test.ts (the helpers
 * moved to src/utils/render/pack.ts).
 */
import { describe, expect, it } from "vitest";
import { floatToFloat16 } from "../../../../src/index";
import { packPlaneToFloat16, toFloat16 } from "../../../../src/dataset/adapters/ome-zarr";

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
