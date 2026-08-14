/**
 * High-level Viewer facade (DX-L1) — see `viewer.ts` for the implementation
 * and `types.ts` for the JSON-serializable config schema.
 */

export { Viewer, ViewerSupersededError, createViewer } from "./viewer";
export type {
  ResolvedViewerMode,
  ViewerCamera,
  ViewerChannelAccessor,
  ViewerChannelConfig,
  ViewerChannelPatch,
  ViewerChannelState,
  ViewerConfig,
  ViewerControlAccessor,
  ViewerControlName,
  ViewerControlOptionsMap,
  ViewerControlsConfig,
  ViewerMagnifierOptions,
  ViewerMode,
  ViewerModeOverride,
  ViewerModeOverrides,
  ViewerProjection,
  ViewerStatus,
  ViewerToolAccessor,
  ViewerToolName,
  ViewerToolOptionsMap,
  ViewerToolsConfig,
  ViewerViewAccessor,
} from "./types";
