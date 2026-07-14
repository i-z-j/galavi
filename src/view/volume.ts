/**
 * VolumeView — 3D volume rendering view.
 *
 * Renders volumetric data with depth testing under a perspective camera
 * derived from the unified camera state. Layer/GPU pipeline lifecycle is
 * delegated to a shared ImagePipeline; VolumeView owns the camera math,
 * mode-transition tween, and depth attachment.
 */

import type { State, Vec3 } from "../types";
import {
  BaseView,
  SCENE_UNIFORM_SIZE,
  type Scene,
} from "./base";
import { ImagePipeline } from "./runtime";
import {
  DEPTH_FORMAT,
  DEFAULT_FOV,
  NEAR_CLIP_FACTOR,
  FAR_CLIP_FACTOR,
  MODE_TRANSITION_MS,
  VOLUME_RAY_SAMPLE_COUNT,
} from "../defaults";

export class VolumeView extends BaseView {
  static readonly viewType = "volume";
  private cameraBuffer! : GPUBuffer;
  private depthTexture? : GPUTexture;
  private pipeline!     : ImagePipeline;

  private lastMode?   : string;
  private lastScene?  : Scene;
  private modeTransition?: {
    startTime : number;
    durationMs: number;
    from      : Scene;
    to        : Scene;
  };

  protected async initGPUResources(): Promise<void> {
    this.cameraBuffer = this.device.createBuffer({
      label: "VolumeView Camera Buffer",
      size : SCENE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const textureSampler = this.device.createSampler({
      label       : "VolumeView Texture Sampler",
      magFilter   : "nearest",
      minFilter   : "nearest",
      mipmapFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    const colormapSampler = this.device.createSampler({
      label       : "VolumeView Colormap Sampler",
      magFilter   : "linear",
      minFilter   : "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.pipeline = new ImagePipeline({
      label               : "VolumeView",
      device              : this.device,
      cameraBuffer        : this.cameraBuffer,
      textureSampler,
      colormapSampler,
      useDepth            : true,
      paramsMinSize       : 80,
      rewriteNonTiledVerts: false,
      requestRender       : () => this.galavi?.requestRender(),
    });

    this.registerDOMEvents();
  }

  protected onLayersChanged(): void {
    this.pipeline?.markDirty();
  }

  override getCurrentLevel(layerId: string): number | undefined {
    return this.pipeline?.getCurrentLevel(layerId);
  }

  protected override onCanvasFormatChanged(): void {
    this.pipeline?.markDirty();
  }

  protected renderFrame(state: State): void {
    if (this.layerEntries.length === 0) return;

    this.pipeline.sync(this.layerEntries);

    const cam           = state.exploration.camera;
    const maxExtent     = Math.max(...(state.physical?.spatial?.size ?? [1, 1, 1]));
    const directCamera  = this.createCamera(cam, maxExtent);
    const camera        = this.getTransitionCamera(cam, directCamera);

    const aspect          = this.canvas.width / this.canvas.height;
    const usefulPixels    = Math.max(1, Math.min(this.canvas.height, VOLUME_RAY_SAMPLE_COUNT));
    this.pipeline.updateTiles(
      this.layerEntries,
      (layer) => {
        const worldBounds = layer.getWorldAABB();
        const segment = worldBounds
          ? frustumSegmentCorners(camera, aspect, worldBounds)
          : undefined;
        if (!segment) {
          return {
            bounds: { min: [1, 1, 1], max: [0, 0, 0] },
            worldUnitsPerPixel: 1,
          };
        }
        const localCorners = segment.corners.map((corner) => (
          this.transformPoint(layer.invModelMatrix, corner)
        ));
        const worldUnitsPerPixel = (
          2 * segment.nearDepth * Math.tan(camera.fov / 2)
        ) / usefulPixels;
        return {
          bounds: {
            min: [0, 1, 2].map((axis) => (
              Math.min(...localCorners.map((corner) => corner[axis]))
            )),
            max: [0, 1, 2].map((axis) => (
              Math.max(...localCorners.map((corner) => corner[axis]))
            )),
          },
          worldUnitsPerPixel,
        };
      },
    );

    // Camera uniform
    const cameraData = this.createPerspectiveUniforms(camera, aspect);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraData as unknown as ArrayBuffer);

    // Depth texture (lazy resize)
    if (
      !this.depthTexture ||
      this.depthTexture.width !== this.canvas.width ||
      this.depthTexture.height !== this.canvas.height
    ) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        label : "VolumeView Depth Texture",
        size  : [this.canvas.width, this.canvas.height],
        format: DEPTH_FORMAT,
        usage : GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    // Per-layer params (with eye in local space) + model uniforms
    this.pipeline.writeFrameUniforms(this.layerEntries, (layer) => {
      const params = layer.getParams() as { setEye?: (eye: Vec3) => void };
      if (typeof params.setEye === "function") {
        const localEye = this.transformPoint(layer.invModelMatrix, camera.position as Vec3);
        params.setEye(localEye);
      }
    });

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

    this.pipeline.draw(pass, this.layerEntries);

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  protected override onDestroy(): void {
    this.pipeline?.destroy();
    this.depthTexture?.destroy();
    this.depthTexture = undefined;
  }

  /** Volume-only: KeyF toggles fly/orbit nav mode. */
  override forward(action: { type: string; payload?: unknown }): void {
    if (action.type === "key:down") {
      const { code } = action.payload as { code: string };
      if (code === "KeyF" && this.galavi) {
        const mode = this.galavi.getState().exploration.camera.navMode;
        this.galavi.setNavMode(mode === "fly" ? "orbit" : "fly");
        return;
      }
    }
    super.forward(action);
  }

  private createCamera(cam: State["exploration"]["camera"], maxExtent: number): Scene {
    return {
      position: [...cam.position] as Vec3,
      target  : [...cam.target] as Vec3,
      up      : cam.up ?? [0, 1, 0],
      fov     : DEFAULT_FOV,
      near    : maxExtent * NEAR_CLIP_FACTOR,
      far     : maxExtent * FAR_CLIP_FACTOR,
    };
  }

  /** Ease between orbit/fly camera presets when navMode flips. */
  private getTransitionCamera(
    cam: State["exploration"]["camera"],
    directCamera: Scene,
  ): Scene {
    const mode = cam.navMode;
    if (this.lastMode !== undefined && this.lastMode !== mode) {
      this.modeTransition = {
        startTime : performance.now(),
        durationMs: MODE_TRANSITION_MS,
        from      : this.lastScene ?? directCamera,
        to        : directCamera,
      };
    }
    this.lastMode        = mode;
    this.lastScene = directCamera;

    if (!this.modeTransition) return directCamera;

    const elapsed = performance.now() - this.modeTransition.startTime;
    const rawT    = Math.min(1, elapsed / this.modeTransition.durationMs);
    const t       = 1 - Math.pow(1 - rawT, 3); // ease-out cubic
    const { from, to } = this.modeTransition;

    const camera: Scene = {
      position: [
        from.position[0] + (to.position[0] - from.position[0]) * t,
        from.position[1] + (to.position[1] - from.position[1]) * t,
        from.position[2] + (to.position[2] - from.position[2]) * t,
      ],
      target: [
        from.target[0] + (to.target[0] - from.target[0]) * t,
        from.target[1] + (to.target[1] - from.target[1]) * t,
        from.target[2] + (to.target[2] - from.target[2]) * t,
      ],
      up  : [0, 1, 0],
      fov : to.fov,
      near: to.near,
      far : to.far,
    };

    if (rawT < 1) {
      requestAnimationFrame(() => this.galavi?.requestRender());
    } else {
      this.modeTransition = undefined;
    }
    return camera;
  }
}

function frustumSegmentCorners(
  camera : Scene,
  aspect : number,
  bounds : { min: Vec3; max: Vec3 },
): { corners: Vec3[]; nearDepth: number } | undefined {
  const forward = normalize3(subtract3(camera.target, camera.position));
  const right   = normalize3(cross3(forward, camera.up));
  const up      = normalize3(cross3(right, forward));
  const boundsCorners = boxCorners(bounds.min, bounds.max);
  const depths = boundsCorners.map((corner) => (
    dot3(subtract3(corner, camera.position), forward)
  ));
  const farDepth = Math.min(camera.far, Math.max(...depths));
  if (farDepth <= camera.near) return undefined;

  const nearestDepth = Math.min(...depths);
  const nearDepth = Math.max(camera.near, nearestDepth);
  if (nearDepth > farDepth) return undefined;

  const corners: Vec3[] = [];
  for (const depth of [nearDepth, farDepth]) {
    const center: Vec3 = [
      camera.position[0] + forward[0] * depth,
      camera.position[1] + forward[1] * depth,
      camera.position[2] + forward[2] * depth,
    ];
    const halfHeight = depth * Math.tan(camera.fov / 2);
    const halfWidth = halfHeight * aspect;
    for (const verticalSign of [-1, 1]) {
      for (const horizontalSign of [-1, 1]) {
        corners.push([
          center[0] + right[0] * halfWidth * horizontalSign + up[0] * halfHeight * verticalSign,
          center[1] + right[1] * halfWidth * horizontalSign + up[1] * halfHeight * verticalSign,
          center[2] + right[2] * halfWidth * horizontalSign + up[2] * halfHeight * verticalSign,
        ]);
      }
    }
  }
  return { corners, nearDepth };
}

function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  const corners: Vec3[] = [];
  for (const z of [min[2], max[2]]) {
    for (const y of [min[1], max[1]]) {
      for (const x of [min[0], max[0]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

function subtract3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}
