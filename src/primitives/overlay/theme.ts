/**
 * Galavi Theme — unified visual theme for overlays and apps.
 *
 * The theme is a plain data object. Overlays receive it through
 * `OverlayBinding.getTheme()` (resolved from `ViewerRuntimeConfig.theme`) and MAY
 * override parts of it via their `theme` option. `BaseOverlay` writes the
 * resolved theme as `--galavi-*` CSS custom properties on its root element;
 * overlay inline styles reference `var(--galavi-*)`, so restyling never
 * requires a stylesheet and apps can still override from CSS.
 *
 * `DEFAULT_THEME` is the neutral, domain-free built-in default. `FUI_THEME`
 * and `PRECISION_THEME` are opt-in presets. Apps import a preset /
 * `applyThemeTo` from the package root and call `applyThemeTo(appRoot)` once
 * so app-rendered UI shares the exact same palette — a single source of truth.
 */

// ============================================================================
// THEME
// ============================================================================

export interface GalaviTheme {
  /** Primary accent — crosshairs, rulers, active highlights. */
  accent      : string;
  /** Translucent accent — glows, fills, selection tint. */
  accentSoft  : string;
  /** Secondary highlight — measurements, warnings. */
  warn        : string;
  /** Primary text. */
  text        : string;
  /** Secondary / dimmed text. */
  textDim     : string;
  /** Translucent panel background. */
  panelBg     : string;
  /** Hairline border. */
  border      : string;
  /** Monospace font stack. */
  fontMono    : string;
  /** Base overlay font size. */
  fontSize    : string;
}

/** Default theme — neutral monochrome chrome, no domain identity. */
export const DEFAULT_THEME: GalaviTheme = {
  accent      : "#E0E0E0",
  accentSoft  : "rgba(224, 224, 224, 0.18)",
  warn        : "#FFC966",
  text        : "#F0F0F0",
  textDim     : "#9A9A9A",
  panelBg     : "rgba(16, 16, 16, 0.72)",
  border      : "rgba(255, 255, 255, 0.22)",
  fontMono    : "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize    : "11px",
};

/** FUI preset — cyan/amber holographic HUD on dark glass. */
export const FUI_THEME: GalaviTheme = {
  accent      : "#46E6FF",
  accentSoft  : "rgba(70, 230, 255, 0.28)",
  warn        : "#FFB454",
  text        : "#D8F4FF",
  textDim     : "#7FA8B8",
  panelBg     : "rgba(6, 20, 28, 0.72)",
  border      : "rgba(70, 230, 255, 0.28)",
  fontMono    : "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize    : "11px",
};

/** Precision preset — monochrome, low-decoration chrome for analytical work. */
export const PRECISION_THEME: GalaviTheme = {
  accent      : "#F5F5F5",
  accentSoft  : "rgba(255, 255, 255, 0.10)",
  warn        : "#FFFFFF",
  text        : "#F4F4F4",
  textDim     : "#A3A3A3",
  panelBg     : "rgba(0, 0, 0, 0.90)",
  border      : "rgba(255, 255, 255, 0.36)",
  fontMono    : "IBM Plex Mono, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize    : "11px",
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Resolve a partial theme over the default theme. */
export function resolveTheme(partial?: DeepPartial<GalaviTheme>): GalaviTheme {
  return mergeTheme(DEFAULT_THEME, partial);
}

/** Merge a partial theme over a complete base theme (all fields are scalar). */
export function mergeTheme(base: GalaviTheme, override?: DeepPartial<GalaviTheme>): GalaviTheme {
  if (!override) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (typeof value === "string") {
      (out as Record<string, string>)[key] = value;
    }
  }
  return out;
}

// ============================================================================
// CSS CUSTOM PROPERTIES
// ============================================================================

/** Theme field name → CSS custom property name. */
const CSS_VARS: Record<keyof GalaviTheme, string> = {
  accent      : "--galavi-accent",
  accentSoft  : "--galavi-accent-soft",
  warn        : "--galavi-warn",
  text        : "--galavi-text",
  textDim     : "--galavi-text-dim",
  panelBg     : "--galavi-panel-bg",
  border      : "--galavi-border",
  fontMono    : "--galavi-font-mono",
  fontSize    : "--galavi-font-size",
};

/**
 * Write the theme as `--galavi-*` CSS custom properties on an element.
 * Used by `BaseOverlay` on overlay roots and by apps on their root element.
 */
export function applyThemeTo(el: HTMLElement, theme?: DeepPartial<GalaviTheme>): void {
  const resolved = resolveTheme(theme);
  for (const [key, cssVar] of Object.entries(CSS_VARS)) {
    el.style.setProperty(cssVar, resolved[key as keyof GalaviTheme]);
  }
}
