/**
 * View runtime — host-side machinery shared by concrete views.
 *
 * - `image-pipeline.ts` — per-layer GPU pipeline cache
 * - `factory.ts`        — `createView` + `ViewRuntime`
 */

export {
  ImagePipeline,
  type ImagePipelineOpts,
} from "./image-pipeline";
export { createView, type ViewRuntime } from "./factory";
