/**
 * SliceView — 2D slice rendering view.
 *
 * Renders cross-sections (XY/YZ/XZ) of volumetric data with an
 * orthographic camera derived from the unified camera state. Layer/GPU
 * pipeline lifecycle is delegated to a shared ImagePipeline; SliceView
 * owns the axis permutation and 2D framing math.
 */

import type { State, Vec3 } from "../types";
import { cameraDistance, type AxisMap } from "../utils";
import { SliceLayer } from "../layer";
import {
  BaseView,
  SCENE_UNIFORM_SIZE,
  type Scene,
} from "./base";
import { ImagePipeline } from "./runtime";

export class SliceView extends BaseView {
  static readonly viewType = "slice";
  private cameraBuffer! : GPUBuffer;
  private pipeline!     : ImagePipeline;

  /** Axis permutation, resolved from first slice layer or default xy. */
  private _axisMap?: AxisMap;

  private get axisMap(): AxisMap {
    if (this._axisMap) return this._axisMap;
    const entry = this.layerEntries[0];
    if (entry instanceof SliceLayer) {
      this._axisMap = entry.axisMap;
      return this._axisMap;
    }
    this._axisMap = [0, 1, 2];
    return this._axisMap;
  }

  protected override getAxisMap(): [number, number, number] | undefined {
    return this.axisMap;
  }

  protected async initGPUResources(): Promise<void> {
    this.cameraBuffer = this.device.createBuffer({
      label: "SliceView Camera Buffer",
      size : SCENE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const textureSampler = this.device.createSampler({
      label    : "SliceView Texture Sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    const colormapSampler = this.device.createSampler({
      label       : "SliceView Colormap Sampler",
      magFilter   : "linear",
      minFilter   : "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.pipeline = new ImagePipeline({
      label               : "SliceView",
      device              : this.device,
      cameraBuffer        : this.cameraBuffer,
      textureSampler,
      colormapSampler,
      useDepth            : false,
      paramsMinSize       : 48,
      rewriteNonTiledVerts: true,
      requestRender       : () => this.galavi?.requestRender(),
    });

    this.registerDOMEvents();
  }

  protected onLayersChanged(): void {
    this.pipeline?.markDirty();
  }

  protected override onCanvasFormatChanged(): void {
    this.pipeline?.markDirty();
  }

  protected renderFrame(state: State): void {
    if (this.layerEntries.length === 0) return;

    this.pipeline.sync(this.layerEntries);

    const cam = state.exploration.camera;
    const am  = this.axisMap;

    // Ortho framing: half-extent in world units along the slice plane.
    const sceneSize      = (state.physical?.spatial?.size ?? [1, 1, 1]) as Vec3;
    const sliceExtent    = Math.max(sceneSize[am[0]], sceneSize[am[1]], 1e-6);
    const dist           = cameraDistance(cam);
    const effectiveScale = sliceExtent / dist;
    const halfExtent     = sliceExtent / (2 * effectiveScale);

    const target2D: [number, number] = [cam.target[am[0]], cam.target[am[1]]];
    const camera: Scene = {
      position: [target2D[0], target2D[1], 1],
      target  : [target2D[0], target2D[1], 0],
      up      : [0, 1, 0],
      fov     : halfExtent,
      near    : -1.0,
      far     : 1.0,
    };

    // Update tiles in each layer's local 2D plane.
    const lod = state.exploration.lod;
    const planeTarget: Vec3 = [cam.target[am[0]], cam.target[am[1]], 0];
    this.pipeline.updateTiles(
      this.layerEntries,
      effectiveScale,
      (layer) => {
        const localTarget = this.transformPoint(layer.invModelMatrix, planeTarget);
        return [localTarget[0], localTarget[1]];
      },
      { resolutionMode: lod.mode, resolutionLevel: lod.level },
    );

    // Camera + per-layer uniforms
    const aspect     = this.canvas.width / this.canvas.height;
    const cameraData = this.createOrthographicUniforms(camera, aspect);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraData as unknown as ArrayBuffer);
    this.pipeline.writeFrameUniforms(this.layerEntries);

    const encoder = this.device.createCommandEncoder();
    const pass    = encoder.beginRenderPass({
      colorAttachments: [{
        view      : this.context.getCurrentTexture().createView(),
        clearValue: [0, 0, 0, 1],
        loadOp    : "clear",
        storeOp   : "store",
      }],
    });
    this.pipeline.draw(pass, this.layerEntries);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  protected override onDestroy(): void {
    this.pipeline?.destroy();
  }

  protected override clampState(state: State): State {
    return this.clampLodLevel(state);
  }
}
