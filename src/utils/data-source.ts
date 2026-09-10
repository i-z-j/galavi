/**
 * Data source helpers — generic `Data` config utilities shared by layers.
 *
 * `dataSourceChanged` is the reload guard used by layers that fetch external
 * resources; `resolveDataUrl` is the single URL-substitution path used by tile
 * fetchers, surface loaders, and shape loaders. Both operate purely on the
 * `Data` contract from `state/schema` — the utils barrel boundary holds: utils
 * must not import from `viewer/`.
 */

import type { Data } from "../state/schema";

/**
 * Whether the reload-relevant content identity of a `Data` source changed.
 * Compares `url`, `urlTemplate`, `fetch`, `pyramid`, and `geometry`;
 * intentionally excludes `transform`, which `BaseLayer` handles separately.
 */
export function dataSourceChanged(
  next?: Data,
  prev?: Data,
): boolean {
  return (
    next?.url !== prev?.url ||
    next?.urlTemplate !== prev?.urlTemplate ||
    next?.fetch !== prev?.fetch ||
    next?.pyramid !== prev?.pyramid ||
    next?.geometry !== prev?.geometry
  );
}

/**
 * Resolve a `Data` source to a concrete URL.
 *
 * If `urlTemplate` is set, substitutes `{url}` plus every key in `vars`
 * (with values stringified). Otherwise falls back to `url`. Throws when
 * neither is defined. The single substitution path used by tile fetchers,
 * surface loaders, and shape loaders.
 */
export function resolveDataUrl(
  source  : Pick<Data, "url" | "urlTemplate">,
  vars?   : Record<string, string | number | undefined>,
): string {
  if (source.urlTemplate) {
    let url = source.urlTemplate.replace("{url}", source.url ?? "");
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) continue;
        url = url.replace(`{${key}}`, String(value));
      }
    }
    return url;
  }
  if (source.url) return source.url;
  throw new Error("DataSource must have either url, urlTemplate, or fetch");
}
