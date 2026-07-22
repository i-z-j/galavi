/**
 * Image pipeline — shared raster machinery for views.
 *
 * Owns the per-layer GPU pipeline cache used by VolumeView, SliceView, and
 * NavigatorView. Per-frame protocol:
 *   1. host calls `markDirty()` whenever the view's layer set changes
 *   2. `sync(layers)`            — rebuild drifted pipelines, refresh colormaps
 *   3. `writeFrameUniforms(...)` — write per-layer params + model uniforms
 *   4. `draw(pass, layers)`      — sorted, visible draw calls
 *   5. `destroy()`               — view cleanup
 */

import type { Render, ViewResolution } from "../../types";
import {
  getColormapLUT,
  TileManager,
  type TilePlacement,
  type TileViewport,
} from "../../utils";
import { COLORMAP_TEXTURE_WIDTH, DEPTH_FORMAT } from "../../defaults";
import {
  BaseLayer,
  getBlendConfig,
  type VertexAttribute,
} from "../../layer";
import { sortedByBlending } from "../base";

// ============================================================================
// IMAGE PIPELINE
// ============================================================================

/**
 * Per-layer renderer cached inside an `ImagePipeline`.
 *
 * Owns the GPU residency for one layer in one view: pipeline + bind groups,
 * params/model/storage buffers, colormap texture, and (for tiled image
 * layers) the entire `TileManager` + `TilePool`. Layers are pure data — they
 * describe what tiles they want via `planTiles()`; this object actually
 * fetches, allocates slots, and uploads them.
 */
interface LayerRenderer {
  pipeline           : GPURenderPipeline;
  vertexBuffer       : GPUBuffer;
  paramsBuffer       : GPUBuffer;
  modelBuffer?       : GPUBuffer;
  storageBuffer?     : GPUBuffer;
  bindGroup          : GPUBindGroup;
  tileBindGroup?     : GPUBindGroup;
  colormapTexture?   : GPUTexture;
  /** Tile residency for tiled image layers; absent for non-tiled layers. */
  tileManager?       : TileManager<TilePlacement>;
  /** Coarsest level shown before automatic best-fit streaming starts. */
  initialTileLevel?  : number;
  /** Previous automatic target for view-local level hysteresis. */
  automaticTileLevel?: number;
  /** Resolution currently requested/displayed by this view renderer. */
  resolution?        : ViewResolution;
  showingInitialTiles: boolean;
  /** Layer.dataVersion at last sync — drop tile residency when it bumps. */
  lastDataVersion    : number;
  layer              : BaseLayer;
  geometryVersion    : number;
  lastBlending       : Render["blending"];
  lastColormapVersion: number;
}

export interface ImagePipelineOpts {
  /** Label prefix for GPU object names. */
  label                : string;
  device               : GPUDevice;
  /** Scene/camera uniform shared with the host view. */
  cameraBuffer         : GPUBuffer;
  /**
   * Sampler bound at group(0) binding 3 for tile textures.
   * Required if any layer in this view is tiled; optional otherwise
   * (e.g. NavigatorView, which only renders untiled layers).
   */
  textureSampler?      : GPUSampler;
  /**
   * Sampler bound at group(0) binding 5 for colormap LUTs.
   * Required if any layer in this view is tiled; optional otherwise.
   */
  colormapSampler?     : GPUSampler;
  /** Add a depth-stencil attachment to render pipelines (3D views). */
  useDepth             : boolean;
  /** Min size in bytes for the per-layer params uniform buffer. */
  paramsMinSize        : number;
  /** Rewrite non-tiled layer vertex buffers each draw (slice views). */
  rewriteNonTiledVerts : boolean;
  /** Called after a tile upload completes so the host view can repaint. */
  requestRender?       : () => void;
}

export class ImagePipeline {
  private states = new Map<string, LayerRenderer>();
  private dirty  = true;

  constructor(private opts: ImagePipelineOpts) {}

  /** Mark the cache as needing a full sync. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Reconcile cached pipelines with the current layer set. */
  sync(layers: readonly BaseLayer[]): void {
    if (!this.dirty) {
      // Drift detection: geometry/blending requires a full pipeline rebuild.
      // dataVersion (source/selection/sliceIndex change) only invalidates
      // tile residency content — pool structure is stable, no rebuild needed.
      // colormap version is patched in place.
      for (const ds of this.states.values()) {
        if (
          ds.layer.geometryVersion !== ds.geometryVersion ||
          ds.lastBlending !== ds.layer.blending
        ) {
          this.dirty = true;
          break;
        }
        if (ds.lastDataVersion !== ds.layer.dataVersion) {
          this.resetTileResidency(ds);
        }
        if (ds.lastColormapVersion !== ds.layer.colormapVersion) {
          this.updateColormapTexture(ds);
        }
      }
    }
    if (!this.dirty) return;

    const liveIds = new Set(layers.map((l) => l.id));
    for (const [id, ds] of this.states) {
      if (!liveIds.has(id)) {
        this.destroyDeferred(ds);
        this.states.delete(id);
      }
    }
    for (const layer of layers) {
      const existing = this.states.get(layer.id);
      const needsRebuild =
        !existing ||
        existing.geometryVersion !== layer.geometryVersion ||
        existing.lastBlending !== layer.blending;
      if (needsRebuild) {
        if (existing) {
          this.destroyDeferred(existing);
          this.states.delete(layer.id);
        }
        const built = this.build(layer);
        if (built) this.states.set(layer.id, built);
      } else {
        if (existing!.lastDataVersion !== layer.dataVersion) {
          this.resetTileResidency(existing!);
        }
        if (existing!.lastColormapVersion !== layer.colormapVersion) {
          this.updateColormapTexture(existing!);
        }
      }
    }
    this.dirty = false;
  }

  /**
   * Drive every renderer's tile residency for this frame. For each layer,
    * computes its camera/canvas-aware `TileFramePlan` and commits it
   * to the renderer's `TileManager`. Non-tiled layers are no-ops.
   *
    * `getViewport(layer)` returns normalized local bounds plus physical display
    * density; the pipeline adds renderer-owned cache and coarse-first inputs.
   */
  updateTiles(
    layers      : readonly BaseLayer[],
    getViewport : (layer: BaseLayer) => Omit<
      TileViewport,
      "tileBudget" | "currentLevel" | "forcedLevel"
    >,
  ): void {
    for (const layer of layers) {
      const ds = this.states.get(layer.id);
      if (!ds || !ds.tileManager) continue;
      const pool = ds.tileManager.pool;
      if (!pool) continue;

      if (ds.showingInitialTiles && ds.tileManager.hasVisibleTile()) {
        ds.showingInitialTiles = false;
      }
      const frameViewport = getViewport(layer);
      const showingInitial = ds.showingInitialTiles;
      const viewport: TileViewport = {
        ...frameViewport,
        tileBudget: pool.capacity - 1,
        ...(!showingInitial && ds.automaticTileLevel !== undefined
          ? { currentLevel: ds.automaticTileLevel }
          : {}),
        ...(showingInitial && ds.initialTileLevel !== undefined
          ? { forcedLevel: ds.initialTileLevel }
          : {}),
      };
      const frame = layer.planTiles(viewport);
      if (!frame) continue;
      const targetLevel = frame.plan.level;
      if (!showingInitial) ds.automaticTileLevel = targetLevel;
      const commit = ds.tileManager.commit(frame.plan, frame.loader);
      const displayedLevel = commit.displayedLevel ?? targetLevel;
      const sourceUnitsPerPixel = layer.getLevelResolution(displayedLevel);
      if (sourceUnitsPerPixel !== undefined) {
        ds.resolution = {
          level                 : displayedLevel,
          targetLevel,
          sourceUnitsPerPixel,
          viewportUnitsPerPixel : frameViewport.worldUnitsPerPixel,
          unitsPerPixel         : Math.max(
            sourceUnitsPerPixel,
            frameViewport.worldUnitsPerPixel,
          ),
        };
      }
    }
  }

  /** Pyramid level currently supplying visible pixels in this view. */
  getCurrentLevel(layerId: string): number | undefined {
    return this.states.get(layerId)?.resolution?.level;
  }

  getResolution(layerId: string): ViewResolution | undefined {
    const resolution = this.states.get(layerId)?.resolution;
    return resolution ? { ...resolution } : undefined;
  }

  /** Recompute best fit on the next frame without discarding reusable tiles. */
  resetResolutionSelection(): void {
    for (const state of this.states.values()) {
      state.automaticTileLevel = undefined;
      state.resolution = undefined;
    }
  }

  /**
   * Write per-layer params + model uniforms for the current frame.
   * `beforeWrite` lets the host mutate `layer.getParams()` (e.g. setEye)
   * before serialization.
   */
  writeFrameUniforms(
    layers      : readonly BaseLayer[],
    beforeWrite?: (layer: BaseLayer) => void,
  ): void {
    const { device } = this.opts;
    for (const layer of layers) {
      const ds = this.states.get(layer.id);
      if (!ds) continue;
      beforeWrite?.(layer);
      const paramsData = layer.getParams().toBuffer();
      device.queue.writeBuffer(ds.paramsBuffer, 0, paramsData as unknown as ArrayBuffer);
      if (ds.modelBuffer) {
        device.queue.writeBuffer(ds.modelBuffer, 0, layer.modelMatrix as unknown as ArrayBuffer);
      }
    }
  }

  /** Iterate sorted, visible layers and emit bind+draw calls into `pass`. */
  draw(pass: GPURenderPassEncoder, layers: readonly BaseLayer[]): void {
    const { device, rewriteNonTiledVerts } = this.opts;
    for (const layer of sortedByBlending(layers)) {
      if (!layer.visible) continue;
      const ds = this.states.get(layer.id);
      if (!ds) continue;
      pass.setPipeline(ds.pipeline);
      pass.setBindGroup(0, ds.bindGroup);
      if (ds.tileBindGroup) pass.setBindGroup(1, ds.tileBindGroup);
      pass.setVertexBuffer(0, ds.vertexBuffer);

      const geom     = layer.getGeometry();
      if (rewriteNonTiledVerts && !ds.tileManager?.pool) {
        device.queue.writeBuffer(
          ds.vertexBuffer,
          0,
          geom.vertices as unknown as ArrayBuffer,
        );
      }
      const instanceCount = geom.instanceCount ?? 1;
      if (geom.vertexCount <= 0 || instanceCount <= 0) continue;
      pass.draw(geom.vertexCount, instanceCount);
    }
  }

  destroy(): void {
    for (const ds of this.states.values()) this.destroyDeferred(ds);
    this.states.clear();
  }

  // ---- private ----------------------------------------------------------

  private build(layer: BaseLayer): LayerRenderer | null {
    const { device, label, cameraBuffer, textureSampler, colormapSampler, useDepth, paramsMinSize, requestRender } = this.opts;
    const geometry = layer.getGeometry();
    const shader   = layer.getShader();

    // Tiled layers: allocate the residency before binding shader resources.
    const tileSpec = layer.getTileSpec();
    let tileManager: TileManager<TilePlacement> | undefined;
    if (tileSpec) {
      tileManager = new TileManager<TilePlacement>(4);
      tileManager.init({
        device,
        slotSize      : tileSpec.slotSize,
        format        : tileSpec.format,
        bytesPerTexel : tileSpec.bytesPerTexel,
        label         : tileSpec.label,
        maxPoolSize   : tileSpec.maxPoolSize,
      });
      if (requestRender) tileManager.setOnUpdate(requestRender);
    }
    const tilePool = tileManager?.pool;

    const vertexBuffer = device.createBuffer({
      label: `${label} ${layer.id} Vertex`,
      size : geometry.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, geometry.vertices as unknown as ArrayBuffer);

    const paramsData   = layer.getParams().toBuffer();
    const paramsBuffer = device.createBuffer({
      label: `${label} ${layer.id} Params`,
      size : Math.max(paramsData.byteLength, paramsMinSize),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(paramsBuffer, 0, paramsData as unknown as ArrayBuffer);

    const needsModel = !!tilePool || (shader.bindings?.model ?? true);
    const modelBuffer = needsModel
      ? device.createBuffer({
          label: `${label} ${layer.id} Model`,
          size : 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
      : undefined;
    if (modelBuffer) {
      device.queue.writeBuffer(modelBuffer, 0, layer.modelMatrix as unknown as ArrayBuffer);
    }

    const shaderModule = device.createShaderModule({
      code : shader.code,
      label: `${label} ${layer.id} Shader`,
    });

    const vertexAttributes: GPUVertexAttribute[] = geometry.attributes
      ? geometry.attributes.map((attr: VertexAttribute) => ({
          shaderLocation: attr.shaderLocation,
          offset        : attr.offset,
          format        : attr.format,
        }))
      : [{ shaderLocation: 0, offset: 0, format: geometry.vertexFormat ?? "float32x3" }];

    const blendCfg = getBlendConfig(layer.blending);

    const pipeline = device.createRenderPipeline({
      label   : `${label} ${layer.id} Pipeline`,
      layout  : "auto",
      vertex  : {
        module    : shaderModule,
        entryPoint: shader.vertex,
        buffers   : [{ arrayStride: geometry.vertexStride, attributes: vertexAttributes }],
      },
      fragment: {
        module    : shaderModule,
        entryPoint: shader.fragment,
        targets   : [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: blendCfg.blendState }],
      },
      primitive: { topology: geometry.topology },
      ...(useDepth
        ? {
            depthStencil: {
              format           : DEPTH_FORMAT,
              depthWriteEnabled: blendCfg.depthWriteEnabled,
              depthCompare     : blendCfg.depthCompare,
            },
          }
        : {}),
    });

    if (tilePool) {
      // Tiled image path: texture + colormap LUT bound at group(0)
      // (tilePool implies needsModel=true, so modelBuffer exists)
      if (!textureSampler || !colormapSampler) {
        throw new Error(
          `[ImagePipeline ${label}] tiled layer "${layer.id}" requires textureSampler and colormapSampler in opts`,
        );
      }
      const tileModelBuffer = modelBuffer!;
      const colormapLUT     = getColormapLUT(layer.colormap, layer.displayColor);
      const colormapTexture = device.createTexture({
        label : `${label} ${layer.id} Colormap`,
        size  : [COLORMAP_TEXTURE_WIDTH, 1],
        format: "rgba8unorm",
        usage : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: colormapTexture },
        colormapLUT as unknown as ArrayBuffer,
        { bytesPerRow: COLORMAP_TEXTURE_WIDTH * 4 },
        [COLORMAP_TEXTURE_WIDTH, 1],
      );

      const bindGroup = device.createBindGroup({
        label  : `${label} ${layer.id} BindGroup`,
        layout : pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: cameraBuffer } },
          { binding: 1, resource: { buffer: paramsBuffer } },
          { binding: 2, resource: tilePool.texture.createView() },
          { binding: 3, resource: textureSampler },
          { binding: 4, resource: colormapTexture.createView() },
          { binding: 5, resource: colormapSampler },
          { binding: 6, resource: { buffer: tileModelBuffer } },
        ],
      });

      const tileBindGroup = device.createBindGroup({
        label  : `${label} ${layer.id} TileBindGroup`,
        layout : pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: tilePool.indexBuffer } },
          { binding: 1, resource: { buffer: tilePool.readyBuffer } },
          { binding: 2, resource: { buffer: tilePool.regionBuffer } },
        ],
      });

      return {
        pipeline, vertexBuffer, paramsBuffer, modelBuffer: tileModelBuffer,
        bindGroup, tileBindGroup, colormapTexture, layer,
        tileManager,
        initialTileLevel  : tileSpec!.initialLevel,
        showingInitialTiles: true,
        geometryVersion    : layer.geometryVersion,
        lastBlending       : layer.blending,
        lastColormapVersion: layer.colormapVersion,
        lastDataVersion    : layer.dataVersion,
      };
    }

    // Non-tiled overlay (surfaces, shapes, points, vectors, ...)
    const bindEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: paramsBuffer } },
    ];
    if (modelBuffer) {
      bindEntries.push({ binding: 2, resource: { buffer: modelBuffer } });
    }
    let storageBuffer: GPUBuffer | undefined;
    const storageData = layer.getStorageData();
    if (storageData) {
      storageBuffer = device.createBuffer({
        label: storageData.label ?? `${label} ${layer.id} Storage`,
        size : Math.max(storageData.data.byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(storageBuffer, 0, storageData.data as unknown as ArrayBuffer);
      bindEntries.push({ binding: 3, resource: { buffer: storageBuffer } });
    }

    const bindGroup = device.createBindGroup({
      label  : `${label} ${layer.id} BindGroup`,
      layout : pipeline.getBindGroupLayout(0),
      entries: bindEntries,
    });

    return {
      pipeline, vertexBuffer, paramsBuffer, modelBuffer,
      storageBuffer, bindGroup, layer,
      showingInitialTiles: false,
      geometryVersion    : layer.geometryVersion,
      lastBlending       : layer.blending,
      lastColormapVersion: layer.colormapVersion,
      lastDataVersion    : layer.dataVersion,
    };
  }

  private updateColormapTexture(ds: LayerRenderer): void {
    if (!ds.colormapTexture) return;
    const colormapLUT = getColormapLUT(ds.layer.colormap, ds.layer.displayColor);
    this.opts.device.queue.writeTexture(
      { texture: ds.colormapTexture },
      colormapLUT as unknown as ArrayBuffer,
      { bytesPerRow: COLORMAP_TEXTURE_WIDTH * 4 },
      [COLORMAP_TEXTURE_WIDTH, 1],
    );
    ds.lastColormapVersion = ds.layer.colormapVersion;
  }

  /**
   * Layer signalled `dataVersion` drift (source/selection/sliceIndex change).
   * Tile pool structure is determined by `getTileSpec()` (constructor-time
   * config + class constants) and never changes, so we keep the pool, the
   * pipeline, and all bind groups; we just clear the slot mapping + load
   * queue so the next `updateTiles()` repopulates with fresh content.
   */
  private resetTileResidency(ds: LayerRenderer): void {
    ds.tileManager?.reset();
    ds.automaticTileLevel = undefined;
    ds.resolution = undefined;
    ds.showingInitialTiles = ds.initialTileLevel !== undefined;
    ds.lastDataVersion  = ds.layer.dataVersion;
  }

  private destroyDeferred(ds: LayerRenderer): void {
    // The TilePool is owned by the renderer's TileManager — destroy it
    // synchronously alongside the rest of the renderer's GPU resources, but
    // gate buffer destruction on submitted-work-done so any in-flight draws
    // referencing them complete first.
    const tileManager = ds.tileManager;
    void this.opts.device.queue.onSubmittedWorkDone().then(() => {
      ds.vertexBuffer.destroy();
      ds.paramsBuffer.destroy();
      ds.modelBuffer?.destroy();
      ds.storageBuffer?.destroy();
      ds.colormapTexture?.destroy();
      tileManager?.pool?.destroy();
    });
    // Drop the load queue + tile cache eagerly so pending fetches don't
    // upload into a destroyed pool.
    tileManager?.reset();
  }
}
