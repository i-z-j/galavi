/**
 * NavigatorView — 3D overview view.
 *
 * Renders a small overview of the scene with a fixed target on the
 * surface center, fixed framing distance, and an orientation that
 * follows the unified camera. Target/center indication is provided by
 * the crosshair overlay (3-axis mode) when configured on the view.
 */

import type { State, Vec3 } from "../types";
import { computePosition, cameraAngles } from "../utils";
import {
  DEFAULT_FOV,
  NEAR_CLIP_FACTOR,
  FAR_CLIP_FACTOR,
  NAVIGATOR_FRAMING_MARGIN
} from "../defaults";
import { BaseLayer } from "../layer";
import {
  BaseView,
  type Scene,
} from "./base";
import { ImagePipeline } from "./runtime";

export class NavigatorView extends BaseView {
  static readonly viewType = "navigator";
  private cameraBuffer! : GPUBuffer;

  private isCentered = false;

  /** Navigator-specific camera state (fixed target & distance). */
  private surfaceCenter?    : Vec3;
  private fixedDistance?    : number;
  private maxSurfaceExtent? : number;

  protected async initGPUResources(): Promise<void> {
    this.cameraBuffer = this.createCameraBuffer("NavigatorView Camera Buffer");

    // Navigator never renders tiled image data, so texture/colormap samplers
    // are not provided — ImagePipeline's tiled-layer guard would throw if a
    // tiled layer were ever assigned here.
    this.pipeline = new ImagePipeline({
      label               : "NavigatorView",
      device              : this.device,
      cameraBuffer        : this.cameraBuffer,
      useDepth            : true,
      paramsMinSize       : 48,
      rewriteNonTiledVerts: false,
      requestRender       : () => this.galavi?.requestRender(),
    });

    // Navigator is passive — no DOM event handlers.
  }

  protected renderFrame(state: State): void {
    if (this.layerEntries.length === 0) return;

    // Only feed ready layers to the pipeline; skipping prevents zero-byte
    // vertex buffers while a surface is still loading.
    const readyEntries  = this.layerEntries.filter((l) => l.isReady);
    const drawables: BaseLayer[] = [...readyEntries];

    // Refresh framing from the world AABB of ready entries.
    this.refreshFraming();

    this.pipeline.sync(drawables);

    // Auto-center on first ready entry.
    if (!this.isCentered && readyEntries.length > 0) {
      this.autoCenterOnEntry(readyEntries[0]);
    }

    const cam       = state.exploration.camera;
    const target    = this.surfaceCenter ?? ([0.5, 0.5, 0.5] as Vec3);
    const distance  = this.fixedDistance ?? 1.0;
    const ext       = this.maxSurfaceExtent ?? 1;
    const { yaw, pitch } = cameraAngles(cam);

    const camera: Scene = {
      position: computePosition(target, distance, yaw, pitch),
      target,
      up      : [0, 1, 0],
      fov     : DEFAULT_FOV,
      near    : ext * NEAR_CLIP_FACTOR,
      far     : ext * FAR_CLIP_FACTOR,
    };

    const aspect     = this.canvas.width / this.canvas.height;
    const cameraData = this.createPerspectiveUniforms(camera, aspect);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraData as unknown as ArrayBuffer);

    const depthTexture = this.ensureDepthTexture("NavigatorView Depth Texture");

    this.pipeline.writeFrameUniforms(drawables);

    this.encodeFrame(
      (pass) => this.pipeline.draw(pass, drawables),
      depthTexture,
    );
  }

  /** Lazy-init framing from the scene AABB. */
  private refreshFraming(): void {
    const scene = this.getSceneBounds();
    if (!isFinite(scene.min[0])) return;

    const maxDim = scene.maxExtent;
    if (!this.isCentered) {
      this.surfaceCenter    = scene.center;
      this.fixedDistance    = (maxDim / 2) / Math.tan(DEFAULT_FOV / 2) * NAVIGATOR_FRAMING_MARGIN;
      this.maxSurfaceExtent = maxDim;
    }
  }

  /** Auto-center camera on a specific entry's world AABB. */
  private autoCenterOnEntry(entry: BaseLayer): void {
    try {
      const aabb = entry.getWorldAABB();
      if (!aabb) return;
      this.surfaceCenter = [
        (aabb.min[0] + aabb.max[0]) / 2,
        (aabb.min[1] + aabb.max[1]) / 2,
        (aabb.min[2] + aabb.max[2]) / 2,
      ];
      const sx = aabb.max[0] - aabb.min[0];
      const sy = aabb.max[1] - aabb.min[1];
      const sz = aabb.max[2] - aabb.min[2];
      const maxDim = Math.max(sx, sy, sz, 1e-6);
      this.fixedDistance    = (maxDim / 2) / Math.tan(DEFAULT_FOV / 2) * NAVIGATOR_FRAMING_MARGIN;
      this.maxSurfaceExtent = maxDim;
      this.isCentered = true;
    } catch (e) {
      console.warn("NavigatorView: failed to auto-center camera:", e);
    }
  }
}
