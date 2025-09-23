/**
 * NavigatorView — 3D overview view.
 *
 * Renders a small overview of the scene with a fixed target on the
 * surface center, fixed framing distance, and an orientation that
 * follows the unified camera. Hosts an internal PlanesLayer for
 * spatial-context glass planes.
 */

import type { State, ID, Vec3 } from "../types";
import { computePosition, cameraAngles } from "../utils";
import {
  DEPTH_FORMAT,
  DEFAULT_FOV,
  NAVIGATOR_FRAMING_MARGIN
} from "../defaults";
import { BaseLayer, PlanesLayer } from "../layer";
import {
  BaseView,
  SCENE_UNIFORM_SIZE,
  type Scene,
} from "./base";
import { ImagePipeline } from "./runtime";

export class NavigatorView extends BaseView {
  static readonly viewType = "navigator";
  private cameraBuffer! : GPUBuffer;
  private depthTexture? : GPUTexture;
  private pipeline!     : ImagePipeline;

  private isCentered = false;

  /** Navigator-specific camera state (fixed target & distance). */
  private surfaceCenter?    : Vec3;
  private fixedDistance?    : number;
  private maxSurfaceExtent? : number;

  /** Internal reference planes — not part of layerEntries. */
  private planesData: PlanesLayer;

  constructor(id: ID) {
    super(id);
    this.planesData = new PlanesLayer(`${id}-planes`, {
      surfaceCenter: [0.5, 0.5, 0.5],
      size         : 0.04,
      opacity      : 0.2,
    });
  }

  protected async initGPUResources(): Promise<void> {
    this.cameraBuffer = this.device.createBuffer({
      label: "NavigatorView Camera Buffer",
      size : SCENE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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

  protected onLayersChanged(): void {
    this.pipeline?.markDirty();
  }

  protected override onCanvasFormatChanged(): void {
    this.pipeline?.markDirty();
  }

  protected override onDestroy(): void {
    this.pipeline?.destroy();
    this.depthTexture?.destroy();
    this.depthTexture = undefined;
  }

  protected renderFrame(state: State): void {
    if (this.layerEntries.length === 0) return;

    // Only feed ready layers to the pipeline; skipping prevents zero-byte
    // vertex buffers while a surface is still loading.
    const readyEntries  = this.layerEntries.filter((l) => l.isReady);
    const drawables: BaseLayer[] = [...readyEntries, this.planesData];

    // Refresh planes + framing from the world AABB of ready entries.
    this.refreshPlanesAndFraming();

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
      near    : ext * 0.001,
      far     : ext * 10,
    };

    // Reference planes follow the unified slice target.
    this.planesData.setSliceTarget(cam.target);

    const aspect     = this.canvas.width / this.canvas.height;
    const cameraData = this.createPerspectiveUniforms(camera, aspect);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraData as unknown as ArrayBuffer);

    if (
      !this.depthTexture ||
      this.depthTexture.width !== this.canvas.width ||
      this.depthTexture.height !== this.canvas.height
    ) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        label : "NavigatorView Depth Texture",
        size  : [this.canvas.width, this.canvas.height],
        format: DEPTH_FORMAT,
        usage : GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    this.pipeline.writeFrameUniforms(drawables);

    const encoder = this.device.createCommandEncoder();
    const pass    = encoder.beginRenderPass({
      colorAttachments: [{
        view      : this.context.getCurrentTexture().createView(),
        clearValue: [0, 0, 0, 1],
        loadOp    : "clear",
        storeOp   : "store",
      }],
      depthStencilAttachment: {
        view           : this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp    : "clear",
        depthStoreOp   : "store",
      },
    });
    this.pipeline.draw(pass, drawables);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Update reference plane size/center and lazy-init framing from the scene AABB. */
  private refreshPlanesAndFraming(): void {
    const scene = this.getSceneBounds();
    if (!isFinite(scene.min[0])) return;

    const maxDim = scene.maxExtent;
    this.planesData.setSize(maxDim * 0.45);
    this.planesData.setSurfaceCenter(this.surfaceCenter ?? scene.center);

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
