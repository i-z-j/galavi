/**
 * Option parsing — checked readers for untyped config option bags.
 *
 * Config-boundary policy (applied consistently by every built-in layer and
 * control): unknown option keys are ignored, and a known key whose runtime
 * value has the wrong type is treated as absent so the default applies.
 * Every reader therefore returns `undefined` for a missing or mistyped
 * value, letting callers fall back with `?? default`.
 */

import type { Vec2, Vec3 } from "../state/schema";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function optNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

export function optBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Axis spec entries accept names ("x","y","z") or indices (0,1,2). */
export function optAxis(value: unknown): string | number | undefined {
  return typeof value === "string" || isFiniteNumber(value) ? value : undefined;
}

export function optVec2(value: unknown): Vec2 | undefined {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
    ? [value[0], value[1]]
    : undefined;
}

export function optVec3(value: unknown): Vec3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
    ? [value[0], value[1], value[2]]
    : undefined;
}

/** Read an array item by item; `undefined` unless every item parses. */
export function optArray<T>(
  value : unknown,
  read  : (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(read);
  return out.every((item) => item !== undefined) ? (out as T[]) : undefined;
}

/** Read a string-keyed record of finite numbers (e.g. `selection`). */
export function optNumberRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(value)) {
    const num = optNumber(val);
    if (num === undefined) return undefined;
    out[key] = num;
  }
  return out;
}
