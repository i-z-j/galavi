/**
 * Galavi Theme — unified FUI (sci-fi HUD) visual theme for overlays and apps.
 *
 * The theme is a plain data object. Overlays receive it through
 * `OverlayBinding.getTheme()` (resolved from `GalaviConfig.theme`) and MAY
 * override parts of it via their `theme` option. `BaseOverlay` writes the
 * resolved theme as `--galavi-*` CSS custom properties on its root element;
 * overlay inline styles reference `var(--galavi-*)`, so restyling never
 * requires a stylesheet and apps can still override from CSS.
 *
 * Apps (e.g. cerevi-web) import `FUI_THEME` / `applyThemeTo` from the package
 * root and call `applyThemeTo(appRoot)` once so Vue-rendered UI shares the
 * exact same palette — a single source of truth.
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

/** Default FUI theme — cyan/amber holographic HUD on dark glass. */
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

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Resolve a partial theme over the FUI defaults. */
export function resolveTheme(partial?: DeepPartial<GalaviTheme>): GalaviTheme {
  return mergeTheme(FUI_THEME, partial);
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
