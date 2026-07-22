/**
 * Channel utils — biomedical channel colors and contrast-limit math.
 *
 * Adapters (e.g. OME-Zarr) surface raw channel metadata (labels, hex colors,
 * contrast windows); these helpers normalize it into render-ready values.
 * One unified fallback palette covers missing or malformed metadata.
 */

import type { Vec2 } from "../types";

/** Fallback channel colors, cycled by channel index. */
export const CHANNEL_FALLBACK_COLORS = [
  "#00B0FF",
  "#FF3D3D",
  "#7CFFB2",
  "#FFD23D",
  "#C792FF",
  "#FF9F45",
];

/** Normalized contrast window bounds. */
export const CONTRAST_RANGE: Vec2 = [0, 1];

/** Normalize a hex color to `#RRGGBB` uppercase; undefined when malformed. */
export function normalizeHexColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const normalized = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;
  return `#${normalized.toUpperCase()}`;
}

/**
 * Resolve a channel's display color: the adapter-supplied metadata color when
 * valid, otherwise a fallback palette entry (cycled by index).
 */
export function getChannelColor(index: number, metadataColor?: string): string {
  return normalizeHexColor(metadataColor)
    ?? CHANNEL_FALLBACK_COLORS[index % CHANNEL_FALLBACK_COLORS.length];
}

/** Clamp contrast limits into the normalized [0,1] range, ordered low ≤ high. */
export function clampContrastLimits(limits: readonly [number, number] | undefined): Vec2 {
  const rawLow  = limits?.[0];
  const rawHigh = limits?.[1];
  const low     = Number.isFinite(rawLow)  ? Math.max(0, Math.min(1, rawLow!))  : 0;
  const high    = Number.isFinite(rawHigh) ? Math.max(low, Math.min(1, rawHigh!)) : 1;
  return [low, high];
}

/**
 * Build per-channel contrast limits from adapter metadata (e.g. OME-Zarr
 * `omeroChannelContrastLimits`), clamped into [0,1] with [0,1] fallback.
 */
export function buildContrastLimits(
  channelContrastLimits : readonly (readonly [number, number] | undefined)[] | undefined,
  count                 : number,
): Vec2[] {
  return Array.from(
    { length: count },
    (_, index) => clampContrastLimits(channelContrastLimits?.[index]),
  );
}
