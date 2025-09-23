/**
 * Built-in Colormap LUT Definitions
 *
 * Each colormap is a 256×4 Uint8Array (RGBA) for upload as a 256×1 texture.
 * Colormaps are computed on first access and cached.
 */

export type ColormapName =
  | "gray"
  | "magma"
  | "viridis"
  | "inferno"
  | "turbo"
  | "green"
  | "red"
  | "blue"
  | "magenta"
  | "cyan"
  | "yellow";

export interface AppearancePreset {
  label           : string;
  description?    : string;
  colormap?       : ColormapName;
  color?          : string;
  contrastLimits? : [number, number];
}

function normalizeHexColor(color: string): string | undefined {
  const trimmed = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return undefined;
  return `#${trimmed.toUpperCase()}`;
}

export function parseHexColor(color: string): [number, number, number] | undefined {
  const normalized = normalizeHexColor(color);
  if (!normalized) return undefined;

  const value = normalized.slice(1);
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ];
}

/** Generate a 256×4 RGBA Uint8Array from an interpolation function */
function generateLUT(fn: (t: number) => [number, number, number]): Uint8Array {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const [r, g, b] = fn(t);
    data[i * 4 + 0] = Math.round(r * 255);
    data[i * 4 + 1] = Math.round(g * 255);
    data[i * 4 + 2] = Math.round(b * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}

/**
 * Attempt to smoothly interpolate a set of (t, r, g, b) control points.
 * Uses linear interpolation between consecutive control points.
 */
function interpolateControlPoints(
  points: [number, number, number, number][]
): (t: number) => [number, number, number] {
  return (t: number) => {
    if (t <= points[0][0]) return [points[0][1], points[0][2], points[0][3]];
    if (t >= points[points.length - 1][0])
      return [
        points[points.length - 1][1],
        points[points.length - 1][2],
        points[points.length - 1][3],
      ];
    for (let i = 0; i < points.length - 1; i++) {
      const [t0, r0, g0, b0] = points[i];
      const [t1, r1, g1, b1] = points[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
      }
    }
    return [0, 0, 0];
  };
}

// === Simple colormaps ===

const grayFn    = (t: number): [number, number, number] => [t, t, t];
const redFn     = (t: number): [number, number, number] => [t, 0, 0];
const greenFn   = (t: number): [number, number, number] => [0, t, 0];
const blueFn    = (t: number): [number, number, number] => [0, 0, t];
const magentaFn = (t: number): [number, number, number] => [t, 0, t];
const cyanFn    = (t: number): [number, number, number] => [0, t, t];
const yellowFn  = (t: number): [number, number, number] => [t, t, 0];

function createSingleColorFn(color: string): ((t: number) => [number, number, number]) | undefined {
  const rgb = parseHexColor(color);
  if (!rgb) return undefined;

  return (t: number) => [rgb[0] * t, rgb[1] * t, rgb[2] * t];
}

// === Perceptually uniform colormaps (approximations) ===

// Magma: dark → purple → orange → yellow
const magmaFn = interpolateControlPoints([
  [0.0, 0.001, 0.0, 0.014],
  [0.13, 0.082, 0.035, 0.216],
  [0.25, 0.233, 0.059, 0.388],
  [0.38, 0.420, 0.055, 0.408],
  [0.5, 0.608, 0.114, 0.345],
  [0.63, 0.788, 0.216, 0.239],
  [0.75, 0.929, 0.384, 0.157],
  [0.88, 0.992, 0.608, 0.216],
  [1.0, 0.987, 0.991, 0.749],
]);

// Viridis: dark purple → teal → yellow
const viridisFn = interpolateControlPoints([
  [0.0, 0.267, 0.004, 0.329],
  [0.13, 0.282, 0.141, 0.458],
  [0.25, 0.253, 0.265, 0.530],
  [0.38, 0.192, 0.407, 0.554],
  [0.5, 0.127, 0.566, 0.551],
  [0.63, 0.153, 0.688, 0.498],
  [0.75, 0.360, 0.789, 0.387],
  [0.88, 0.667, 0.863, 0.173],
  [1.0, 0.993, 0.906, 0.144],
]);

// Inferno: dark → purple → red → yellow
const infernoFn = interpolateControlPoints([
  [0.0, 0.001, 0.0, 0.014],
  [0.13, 0.090, 0.027, 0.259],
  [0.25, 0.258, 0.039, 0.406],
  [0.38, 0.447, 0.027, 0.392],
  [0.5, 0.624, 0.082, 0.298],
  [0.63, 0.793, 0.196, 0.161],
  [0.75, 0.925, 0.372, 0.020],
  [0.88, 0.981, 0.596, 0.008],
  [1.0, 0.988, 0.998, 0.645],
]);

// Turbo: blue → cyan → green → yellow → red
const turboFn = interpolateControlPoints([
  [0.0, 0.190, 0.072, 0.232],
  [0.07, 0.201, 0.239, 0.580],
  [0.15, 0.136, 0.436, 0.848],
  [0.25, 0.023, 0.616, 0.900],
  [0.35, 0.013, 0.773, 0.747],
  [0.45, 0.192, 0.887, 0.479],
  [0.55, 0.491, 0.955, 0.204],
  [0.65, 0.769, 0.940, 0.058],
  [0.75, 0.945, 0.828, 0.041],
  [0.85, 0.994, 0.627, 0.082],
  [0.92, 0.952, 0.395, 0.089],
  [1.0, 0.700, 0.152, 0.071],
]);

// === LUT cache ===

const lutCache = new Map<string, Uint8Array>();

const COLORMAP_FNS: Record<string, (t: number) => [number, number, number]> = {
  gray    : grayFn,
  red     : redFn,
  green   : greenFn,
  blue    : blueFn,
  magenta : magentaFn,
  cyan    : cyanFn,
  yellow  : yellowFn,
  magma   : magmaFn,
  viridis : viridisFn,
  inferno : infernoFn,
  turbo   : turboFn,
};

export const APPEARANCE_PRESETS = {
  gray: {
    label       : "Gray",
    description : "Neutral grayscale for scalar image data.",
    colormap    : "gray",
  },
  red: {
    label       : "Red",
    description : "Single-channel red ramp.",
    colormap    : "red",
  },
  green: {
    label       : "Green",
    description : "Single-channel green ramp.",
    colormap    : "green",
  },
  blue: {
    label       : "Blue",
    description : "Single-channel blue ramp.",
    colormap    : "blue",
  },
  cyan: {
    label       : "Cyan",
    description : "Single-channel cyan ramp.",
    colormap    : "cyan",
  },
  magenta: {
    label       : "Magenta",
    description : "Single-channel magenta ramp.",
    colormap    : "magenta",
  },
  yellow: {
    label       : "Yellow",
    description : "Single-channel yellow ramp.",
    colormap    : "yellow",
  },
  viridis: {
    label       : "Viridis",
    description : "Perceptually uniform scalar preset.",
    colormap    : "viridis",
  },
  inferno: {
    label       : "Inferno",
    description : "High-contrast scalar preset.",
    colormap    : "inferno",
  },
  magma: {
    label       : "Magma",
    description : "Warm scalar preset.",
    colormap    : "magma",
  },
  turbo: {
    label       : "Turbo",
    description : "Vivid scalar preset.",
    colormap    : "turbo",
  },
  "ct-bone": {
    label           : "CT Bone",
    description     : "Bright window for dense structures.",
    colormap        : "gray",
    contrastLimits  : [0.55, 1],
  },
  "ct-soft-tissue": {
    label           : "CT Soft Tissue",
    description     : "Mid-range window for soft-tissue inspection.",
    colormap        : "gray",
    contrastLimits  : [0.08, 0.42],
  },
  angiography: {
    label           : "Angiography",
    description     : "Vessel-emphasized warm ramp.",
    color           : "#FFB347",
    contrastLimits  : [0.72, 1],
  },
  "mri-soft-tissue": {
    label           : "MRI Soft Tissue",
    description     : "Broad grayscale window for MRI-style volumes.",
    colormap        : "gray",
    contrastLimits  : [0.12, 0.82],
  },
  "simulation-scalar": {
    label           : "Simulation Scalar",
    description     : "Colorful scalar preset for simulation fields.",
    colormap        : "turbo",
    contrastLimits  : [0.05, 0.95],
  },
} as const satisfies Record<string, AppearancePreset>;

export type AppearancePresetId = keyof typeof APPEARANCE_PRESETS;

export function resolveAppearancePreset(id?: string): AppearancePreset | undefined {
  if (!id) return undefined;
  return APPEARANCE_PRESETS[id as AppearancePresetId];
}

/**
 * Get the 256×4 RGBA LUT for a named colormap.
 * Returns the "gray" LUT if the name is unknown.
 */
export function getColormapLUT(name: string, color?: string): Uint8Array {
  const normalizedColor = color ? normalizeHexColor(color) : undefined;
  const cacheKey        = normalizedColor ? `color:${normalizedColor}` : `name:${name}`;
  const cached          = lutCache.get(cacheKey);
  if (cached) return cached;

  const fn = normalizedColor
    ? createSingleColorFn(normalizedColor) ?? grayFn
    : (COLORMAP_FNS[name] ?? grayFn);
  const lut = generateLUT(fn);
  lutCache.set(cacheKey, lut);
  return lut;
}

/** List of all available colormap names */
export const COLORMAP_NAMES: readonly ColormapName[] = [
  "gray", "magma", "viridis", "inferno", "turbo",
  "green", "red", "blue", "magenta", "cyan", "yellow",
];
