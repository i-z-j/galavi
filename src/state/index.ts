/**
 * State module barrel — the scene vocabulary, structural validation, and
 * live-scene normalization. Re-exported from the root entry.
 */

export * from "./schema";
export {
  normalizeInitialState,
  normalizePhysicalSpace,
  normalizeState,
} from "./normalize";
