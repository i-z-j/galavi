/**
 * Dtype packing — normalize raw dtype sample values and encode them as
 * half-precision (r16float) bits for tile upload.
 *
 * Generic tile-source machinery shared by source adapters (e.g. OME-Zarr):
 * adapters read native chunks/planes and pack them into the r16float buffers
 * the tile pool uploads. The float16 conversion itself lives in
 * `./float16.ts` — the single canonical implementation.
 */

import { floatToFloat16 } from "./float16";

/**
 * scale/offset mapping raw dtype sample values to normalized floats:
 * `normalized = (raw + offset) * scale`. Integer dtypes map their full range
 * onto [0, 1]; anything else passes through unchanged (scale 1, offset 0).
 */
export function dtypeNormalization(dtype: string): { scale: number; offset: number } {
  if (dtype.includes("uint8") || dtype === "|u1") {
    return { scale: 1 / 255,   offset: 0 };
  }
  if (dtype.includes("uint16") || dtype.includes("<u2") || dtype.includes(">u2")) {
    return { scale: 1 / 65535, offset: 0 };
  }
  if (dtype.includes("int8") || dtype === "|i1") {
    return { scale: 1 / 255,   offset: 128 };
  }
  if (dtype.includes("int16") || dtype.includes("<i2") || dtype.includes(">i2")) {
    return { scale: 1 / 65535, offset: 32768 };
  }
  return { scale: 1, offset: 0 };
}

/** Encode one raw dtype sample as packed half-precision bits. */
export function makeFloat16Encoder(dtype: string): (value: number) => number {
  const { scale, offset } = dtypeNormalization(dtype);
  return (value) => floatToFloat16((value + offset) * scale);
}
