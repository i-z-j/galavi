/**
 * float16 conversion — IEEE 754 binary32 → binary16 bits.
 */

export function floatToFloat16(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = value;
  const f     = int32View[0];
  const sign  = (f >> 31) & 0x0001;
  const exp   = (f >> 23) & 0x00ff;
  const frac  = f & 0x007fffff;
  // NaN -> canonical quiet NaN (0x7e00), Infinity -> Infinity.
  if (exp === 0xff) return (sign << 15) | (frac !== 0 ? 0x7e00 : 0x7c00);
  const newE = exp - 127 + 15;
  // Magnitudes at/above 2^16 overflow to Infinity.
  if (newE >= 31) return (sign << 15) | 0x7c00;
  if (newE <= 0) {
    // Subnormal half (or zero): shift the 24-bit mantissa (implicit leading 1
    // restored) into place, rounding to nearest, ties to even, with sticky bits.
    // shift > 25 means the magnitude is below half of the smallest subnormal.
    const shift = 14 - newE;
    if (shift > 25) return sign << 15;
    const mantissa = frac | 0x00800000;
    let   kept     = mantissa >> shift;
    const roundBit = (mantissa >> (shift - 1)) & 1;
    const sticky   = (mantissa & ((1 << (shift - 1)) - 1)) !== 0;
    if (roundBit === 1 && (sticky || (kept & 1) === 1)) kept++;
    return (sign << 15) | kept;
  }
  // Normal half: round the 23-bit mantissa to 10 bits, ties to even. Adding
  // (not OR-ing) lets a mantissa overflow carry into the exponent, which also
  // yields Infinity when the largest finite half rounds up.
  let   kept     = frac >> 13;
  const roundBit = (frac >> 12) & 1;
  const sticky   = (frac & 0x00000fff) !== 0;
  if (roundBit === 1 && (sticky || (kept & 1) === 1)) kept++;
  return (sign << 15) | ((newE << 10) + kept);
}
