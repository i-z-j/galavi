/**
 * OME-Zarr image dataset kind — `"ome-zarr"`, exposed via the `galavi/ome-zarr`
 * subpath (zarrita is a regular runtime dependency of galavi, kept external
 * from the bundles; the core entry never imports this module).
 *
 * Opens an OME-Zarr store via zarrita, reads multiscales metadata, and
 * provides a galavi-compatible tile fetch that converts zarr chunks to
 * r16float tiles.
 *
 * Supports OME-Zarr v0.5 (Zarr v3) and v0.4 (Zarr v2).
 * Handles non-spatial selection dimensions (c, t, etc.).
 *
 * 2D (XY-only) datasets are first-class: when the z axis is absent a virtual
 * singleton z is synthesized (shape/chunks z = 1, z scale = y scale, z origin
 * = 0, z unit = y unit), matching galavi's "z=1 for 2D data" convention.
 *
 * All OME/OMERO concepts (multiscales, omero channels) are normalized into
 * galavi's format-neutral `Dataset` contract by {@link ImageDataset}:
 *
 *   - channel count    — the non-spatial `c` axis size, else omero channel
 *                        count, else 1
 *   - labels           — omero labels, else `Channel N`
 *   - colors           — omero colors via `getChannelColor`
 *                        (`#RRGGBB`, tested fallback palette)
 *   - contrast         — omero windows via `buildContrastLimits` (normalized,
 *                        clamped to [0, 1]; `[0, 1]` default)
 *   - visibility       — omero `active` flags when present, otherwise the
 *                        first channel only
 *   - capabilities     — `getDatasetCapabilities` (DX-M4 policy semantics:
 *                        a z-chunk=1 store still advertises a bounded volume
 *                        preview)
 */

import * as zarr from "zarrita";
import type {
  ImagePyramid,
  ImagePyramidLevel,
  LayerConfig,
  PhysicalSpace,
  Vec3,
} from "../types";
import type { AxisIndex, AxisMap } from "../utils/axes";
import { makeFloat16Encoder } from "../utils/tile/pack";
import { buildContrastLimits, getChannelColor } from "../utils/channels";
import { registerDataset } from "../registry";
import {
  Dataset,
  getDatasetCapabilities,
  type DatasetChannel,
  type DatasetConfig,
  type DefaultLayersOptions,
} from "./base";

/**
 * Register the `"ome-zarr"` loader identity: importing `galavi/ome-zarr`
 * extends {@link DatasetConfigMap} (and therefore `DatasetConfig` and the
 * typed `registerDataset`) with this format's exact config. The augmentation
 * targets `./base` — the single `DatasetConfigMap` declaration the public
 * `"galavi"` entry re-exports — so it survives declaration emission verbatim
 * (`dist/dataset/ome-zarr.d.ts` keeps the same relative specifier) and merges
 * with the exact interface every published `DatasetConfig` reference resolves
 * to. (External format packages still augment the public `declare module
 * "galavi"` name, which resolves to the same interface through the root
 * re-export.)
 */
declare module "./base" {
  interface DatasetConfigMap {
    /** OME-Zarr multiscale image loader (the `galavi/ome-zarr` subpath). */
    "ome-zarr": { type: "ome-zarr"; source: string };
  }
}

// ============================================================================
// STORE — zarr store construction with optional fetch injection
// ============================================================================
//
// zarrita 0.6's `FetchStore` accepts `RequestInit` overrides but always calls
// the global `fetch`. To let apps inject an authenticated or URL-signing
// fetcher, `CustomFetchStore` subclasses it and routes `get`/`getRange` (the
// only read methods) through the supplied fetch, mirroring zarrita's URL
// resolution, range semantics, and response handling.
//
// The default store wraps the global fetch with bounded retries and a
// per-request timeout: cloud object stores (and their CDNs) regularly drop or
// truncate responses (`ERR_CONTENT_LENGTH_MISMATCH`, stalled sockets), and a
// tile loader that surfaces every transient blip as a failed tile makes large
// remote pyramids unusable.

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Options accepted by `openOMEZarr`, `fetch2DPlane`, and `openOMEZarrPlate`. */
export interface OMEZarrOptions {
  /**
   * Custom fetch used for every store request — e.g. one that signs URLs or
   * attaches auth headers. Defaults to the global `fetch` wrapped with
   * retries and a 30 s per-attempt timeout.
   */
  fetch?: FetchLike;
}

/** Create the zarr store backing an OME-Zarr source. */
export function createStore(url: string, options?: OMEZarrOptions): zarr.FetchStore {
  const fetchFn = options?.fetch ?? withRetry(globalThis.fetch.bind(globalThis));
  return new CustomFetchStore(url, fetchFn);
}

const RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Wrap a fetch implementation with retries on transient failures (network
 * errors, truncated responses, 429/5xx) and a per-attempt timeout. Permanent
 * HTTP errors (4xx) are returned as-is so callers keep their 404 handling.
 */
export function withRetry(fetchFn: FetchLike): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * RETRY_BASE_DELAY_MS);
      }
      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (init?.signal) signals.push(init.signal);
      try {
        const response = await fetchFn(input, { ...init, signal: AbortSignal.any(signals) });
        // Retry transient server-side failures; keep 4xx (incl. 404) untouched.
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`Transient HTTP ${response.status} ${response.statusText}`);
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (init?.signal?.aborted) throw err; // caller cancelled — not retryable
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RangeQuery = { offset: number; length: number } | { suffixLength: number };

class CustomFetchStore extends zarr.FetchStore {
  readonly #fetchFn: FetchLike;

  constructor(url: string, fetchFn: FetchLike) {
    super(url);
    this.#fetchFn = fetchFn;
  }

  override async get(key: string, options: RequestInit = {}): Promise<Uint8Array | undefined> {
    const response = await this.#fetchFn(resolveUrl(this.url, key).href, options);
    return handleResponse(response);
  }

  override async getRange(
    key: string,
    range: RangeQuery,
    options: RequestInit = {},
  ): Promise<Uint8Array | undefined> {
    const url = resolveUrl(this.url, key);
    if ("suffixLength" in range) {
      // Mirror zarrita's default: HEAD to learn the length, then a ranged GET
      // (suffix Range headers are not universally supported).
      const head = await this.#fetchFn(url, { ...options, method: "HEAD" });
      if (!head.ok) return handleResponse(head);
      const length = Number(head.headers.get("Content-Length"));
      return this.#fetchRange(url, length - range.suffixLength, range.suffixLength, options);
    }
    return this.#fetchRange(url, range.offset, range.length, options);
  }

  async #fetchRange(
    url: URL,
    offset: number,
    length: number,
    init: RequestInit,
  ): Promise<Uint8Array | undefined> {
    const response = await this.#fetchFn(url, {
      ...init,
      headers: { ...init.headers, Range: `bytes=${offset}-${offset + length - 1}` },
    });
    return handleResponse(response);
  }
}

/** Resolve a store key against the store root (same rules as zarrita). */
function resolveUrl(root: string | URL, path: string): URL {
  const base = typeof root === "string" ? new URL(root) : root;
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const resolved = new URL(path.slice(1), base);
  resolved.search = base.search;
  return resolved;
}

/** Response semantics shared by `get`/`getRange` (same rules as zarrita). */
async function handleResponse(response: Response): Promise<Uint8Array | undefined> {
  if (response.status === 404) return undefined;
  if (response.status === 200 || response.status === 206) {
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error(`Unexpected response status ${response.status} ${response.statusText}`);
}

// ============================================================================
// PACK — shared dtype packing helpers
// ============================================================================
//
// Both the 3D tile packer (`toFloat16`) and the 2D plane packer
// (`packPlaneToFloat16`) normalize raw dtype sample values to floats and
// encode them as half-precision (r16float) bits. The dtype normalization and
// float16 conversion live in galavi's tile utils — the single canonical
// implementation.

/**
 * Pack a 3D tile (row major, x-fastest) into an r16float buffer of shape
 * `tileShape`. `validShape` is the portion of the tile that overlaps the
 * source array; the rest stays zero-filled.
 */
export function toFloat16(
  data: ArrayLike<number>,
  dtype: string,
  tileShape: [number, number, number],
  validShape: [number, number, number],
): ArrayBuffer {
  const totalVoxels = tileShape[0] * tileShape[1] * tileShape[2];
  const out         = new Uint16Array(totalVoxels);
  const width       = Math.max(0, Math.min(validShape[0], tileShape[0]));
  const height      = Math.max(0, Math.min(validShape[1], tileShape[1]));
  const depth       = Math.max(0, Math.min(validShape[2], tileShape[2]));
  const len         = Math.min(data.length, width * height * depth);
  const encode      = makeFloat16Encoder(dtype);

  let srcIndex = 0;
  for (let z = 0; z < depth; z++) {
    const zOffset = z * tileShape[1] * tileShape[0];
    for (let y = 0; y < height; y++) {
      const dstRow = zOffset + y * tileShape[0];
      for (let x = 0; x < width && srcIndex < len; x++, srcIndex++) {
        out[dstRow + x] = encode(data[srcIndex]);
      }
    }
  }
  return out.buffer;
}

// ============================================================================
// OPEN — multiscales metadata + tile fetch
// ============================================================================

export interface SelectionDim {
  name           : string;
  size           : number;
  labels?        : string[];
  colors?        : string[];
  contrastLimits?: Array<[number, number] | undefined>;
}

export interface OMEZarrInfo {
  dtype                      : string;
  name                       : string;
  sourceUrl                  : string;
  omeVersion                 : string;
  datasetType?               : string;
  datasetMethod?             : string;
  datasetDescription?        : string;
  pyramid                    : OMEZarrPyramid;
  selectionDims              : SelectionDim[];
  defaultSelection           : Record<string, number>;
  origin                     : Vec3;
  spatialUnits               : [string | undefined, string | undefined, string | undefined];
  omeroChannelLabels?        : string[];
  omeroChannelColors?        : string[];
  omeroChannelContrastLimits?: Array<[number, number] | undefined>;
  omeroChannelActives?       : boolean[];
  fetchTile                  : (options?: {
    level?    : number;
    position? : number[];
    selection?: Record<string, number>;
    signal?   : AbortSignal;
  }) => Promise<ArrayBuffer>;
}

export function getVolumeTransform(info: OMEZarrInfo): {
  scale       : [number, number, number];
  translate   : [number, number, number];
  physicalSize: [number, number, number];
  maxExtent   : number;
  center      : [number, number, number];
} {
  const finest = info.pyramid.levels[0];
  const [sx, sy, sz] = finest.scale;
  const physicalSize: [number, number, number] = [
    finest.shape[0] * sx,
    finest.shape[1] * sy,
    finest.shape[2] * sz,
  ];
  const maxExtent = Math.max(...physicalSize);
  const center: [number, number, number] = [
    info.origin[0] + physicalSize[0] / 2,
    info.origin[1] + physicalSize[1] / 2,
    info.origin[2] + physicalSize[2] / 2,
  ];

  return {
    scale       : physicalSize,
    translate   : [...info.origin],
    physicalSize,
    maxExtent,
    center,
  };
}

/**
 * Extract a galavi-compatible PhysicalSpace from OME-Zarr metadata.
 * Computes physical extent from finest-level shape × physical voxel scale,
 * and reads units from the OME axes metadata.
 */
export function getPhysicalSpace(info: OMEZarrInfo): PhysicalSpace {
  const finest = info.pyramid.levels[0];
  const [sx, sy, sz] = finest.scale;
  const size: [number, number, number] = [
    finest.shape[0] * sx,
    finest.shape[1] * sy,
    finest.shape[2] * sz,
  ];
  // Pick first available spatial unit, normalize common μm variants
  const rawUnit = info.spatialUnits.find(u => u != null);
  const unit = normalizeUnit(rawUnit);
  return {
    spatial: {
      size,
      unit,
      spacing: [...finest.scale],
      origin: [...info.origin],
    },
  };
}

/**
 * Normalize common unit spelling variants (µm/um/micrometer → μm, …).
 * Returns `undefined` when the metadata carries no unit — the adapter does
 * not invent one.
 */
export function normalizeUnit(unit: string | undefined): string | undefined {
  if (!unit) return undefined;
  const n = unit.trim().toLowerCase();
  if (n === "µm" || n === "μm" || n === "um" || n === "micrometer" || n === "micrometre") return "μm";
  if (n === "mm" || n === "millimeter" || n === "millimetre") return "mm";
  if (n === "nm" || n === "nanometer" || n === "nanometre") return "nm";
  return unit;
}

export interface LevelInfo extends ImagePyramidLevel {
  index    : number;
  numChunks: Vec3;
}

export interface OMEZarrPyramid extends ImagePyramid {
  levels: LevelInfo[];
}

interface MultiscaleAxis {
  name : string;
  type?: string;
  unit?: string;
}

interface MultiscaleDataset {
  path                       : string;
  coordinateTransformations?: Array<{
    type        : string;
    scale?      : number[];
    translation?: number[];
  }>;
}

interface Multiscale {
  version? : string;
  axes     : MultiscaleAxis[];
  datasets : MultiscaleDataset[];
  name?    : string;
  type?    : string;
  metadata?: {
    description?    : string;
    method?         : string;
    version?        : string;
    [key: string]   : unknown;
  };
}

interface OmeroChannel {
  color? : string;
  label? : string;
  active?: boolean;
  window?: { min?: number; max?: number; start?: number; end?: number };
}

interface OmeroBlock {
  channels?: OmeroChannel[];
}

interface OmeAttrs {
  version    : string;
  multiscales: Multiscale[];
  omero?     : OmeroBlock;
  name?      : string;
}

export async function openOMEZarr(url: string, options?: OMEZarrOptions): Promise<OMEZarrInfo> {
  const store = createStore(url, options);

  let root: zarr.Group<zarr.FetchStore>;
  try {
    root = await zarr.open.v3(store, { kind: "group" }) as zarr.Group<zarr.FetchStore>;
  } catch {
    root = await zarr.open.v2(store, { kind: "group" }) as zarr.Group<zarr.FetchStore>;
  }

  const attrs       = root.attrs as Record<string, unknown>;
  const omeBlock    = attrs.ome as OmeAttrs | undefined;
  const multiscales = (omeBlock?.multiscales ?? attrs.multiscales) as Multiscale[] | undefined;
  if (!multiscales?.length) {
    throw new Error("No OME-Zarr multiscales metadata found (checked attrs.ome.multiscales and attrs.multiscales)");
  }
  const omeVersion = omeBlock?.version ?? multiscales[0].version ?? "0.4";

  const ms       = multiscales[0];
  const axes     = ms.axes;
  const datasets = ms.datasets;
  if (!datasets?.length) {
    throw new Error("No datasets listed in multiscales metadata");
  }

  const axisNames = axes.map((axis) => axis.name);
  const zIdx = axisNames.indexOf("z");
  const yIdx = axisNames.indexOf("y");
  const xIdx = axisNames.indexOf("x");
  if (yIdx < 0 || xIdx < 0) {
    throw new Error(`Expected x/y spatial axes (z optional), got: [${axisNames.join(", ")}]`);
  }
  // z is optional: when absent, a virtual singleton z axis is synthesized
  // (shape/chunks z = 1, z scale = y scale, z origin = 0, z unit = y unit).
  const hasZ = zIdx >= 0;

  const arrays: zarr.Array<zarr.DataType>[] = await Promise.all(
    datasets.map(async (ds) => {
      const loc = root.resolve(ds.path);
      try {
        return await zarr.open.v3(loc, { kind: "array" }) as zarr.Array<zarr.DataType>;
      } catch {
        return await zarr.open.v2(loc, { kind: "array" }) as zarr.Array<zarr.DataType>;
      }
    }),
  );

  const finestShape: Vec3 = [
    arrays[0].shape[xIdx],
    arrays[0].shape[yIdx],
    hasZ ? arrays[0].shape[zIdx] : 1,
  ];
  const finestScaleTx = datasets[0].coordinateTransformations?.find((entry) => entry.type === "scale");
  const finestScale: Vec3 = finestScaleTx?.scale
    ? [
        finestScaleTx.scale[xIdx],
        finestScaleTx.scale[yIdx],
        hasZ ? finestScaleTx.scale[zIdx] : finestScaleTx.scale[yIdx],
      ]
    : [1, 1, 1];
  const translationTx = datasets[0].coordinateTransformations?.find((entry) => entry.type === "translation");
  const origin: Vec3 = translationTx?.translation
    ? [
        translationTx.translation[xIdx],
        translationTx.translation[yIdx],
        hasZ ? translationTx.translation[zIdx] : 0,
      ]
    : [0, 0, 0];

  const levels: LevelInfo[] = arrays.map((arr, index) => {
    const shape       = arr.shape;
    const chunks      = arr.chunks;
    const levelShape : Vec3 = [shape[xIdx], shape[yIdx], hasZ ? shape[zIdx] : 1];
    const chunkSize  : Vec3 = [chunks[xIdx], chunks[yIdx], hasZ ? chunks[zIdx] : 1];
    const scaleTx = datasets[index].coordinateTransformations?.find((entry) => entry.type === "scale");
    const scale: Vec3 = scaleTx?.scale
      ? [scaleTx.scale[xIdx], scaleTx.scale[yIdx], hasZ ? scaleTx.scale[zIdx] : scaleTx.scale[yIdx]]
      : deriveLevelScale(finestScale, finestShape, levelShape);
    if (!hasZ) scale[2] = scale[1]; // virtual z matches this level's y scale
    return {
      index,
      path     : datasets[index].path,
      shape    : levelShape,
      chunkSize,
      scale,
      numChunks: [
        Math.ceil(levelShape[0] / chunkSize[0]),
        Math.ceil(levelShape[1] / chunkSize[1]),
        Math.ceil(levelShape[2] / chunkSize[2]),
      ],
    };
  });

  const fullArr       = arrays[0];
  const spatialUnits: [string | undefined, string | undefined, string | undefined] = [
    axes[xIdx]?.unit,
    axes[yIdx]?.unit,
    hasZ ? axes[zIdx]?.unit : axes[yIdx]?.unit,
  ];

  const dtype                      = fullArr.dtype;
  const omeroBlock                 = (omeBlock?.omero ?? attrs.omero) as OmeroBlock | undefined;
  const omeroChannels              = omeroBlock?.channels;
  const omeroChannelLabels         = omeroChannels?.map((channel, index) => channel.label || `Ch ${index}`);
  const omeroChannelColors         = omeroChannels?.map((channel) => channel.color || "FFFFFF");
  const omeroChannelActives        = omeroChannels?.map((channel) => channel.active ?? true);
  const dtypeRange                 = getDtypeRange(dtype);
  const omeroChannelContrastLimits = omeroChannels?.map((channel) =>
    channel.window ? getNormalizedDisplayContrast(channel.window, dtypeRange) : undefined,
  );

  const selectionDims   : SelectionDim[]          = [];
  const defaultSelection: Record<string, number>  = {};

  for (let index = 0; index < axes.length; index++) {
    const axis = axes[index];
    if (axis.name === "x" || axis.name === "y" || axis.name === "z") continue;

    const dim: SelectionDim = {
      name   : axis.name,
      size   : fullArr.shape[index],
    };

    if (axis.name === "c" && omeroChannels) {
      dim.labels         = omeroChannelLabels;
      dim.colors         = omeroChannelColors;
      dim.contrastLimits = omeroChannelContrastLimits;
    }

    selectionDims.push(dim);
    defaultSelection[axis.name] = 0;
  }

  const datasetType        = ms.type;
  const datasetMethod      = typeof ms.metadata?.method === "string" ? ms.metadata.method : undefined;
  const datasetDescription = typeof ms.metadata?.description === "string" ? ms.metadata.description : undefined;
  const name               = (omeBlock?.name ?? ms.name) || url.split("/").pop()?.replace(".ome.zarr", "") || "dataset";

  const fetchTile = async (
    options?: {
      level?: number;
      position?: number[];
      selection?: Record<string, number>;
      signal?: AbortSignal;
    },
  ): Promise<ArrayBuffer> => {
    const signal     = options?.signal;
    signal?.throwIfAborted();
    const level     = Math.max(0, Math.min(options?.level ?? 0, arrays.length - 1));
    const position  = options?.position ?? [0, 0, 0];
    const selection = options?.selection ?? defaultSelection;

    const lv  = levels[level];
    const arr = arrays[level];
    const tileSize = lv.chunkSize;
    const totalVoxels = tileSize[0] * tileSize[1] * tileSize[2];
    const x0  = position[0];
    const y0  = position[1];
    const z0  = position[2];

    if (
      x0 < 0 || x0 >= lv.shape[0] ||
      y0 < 0 || y0 >= lv.shape[1] ||
      z0 < 0 || z0 >= lv.shape[2]
    ) {
      return new ArrayBuffer(totalVoxels * 2);
    }

    const x1 = Math.min(x0 + tileSize[0], lv.shape[0]);
    const y1 = Math.min(y0 + tileSize[1], lv.shape[1]);
    const z1 = Math.min(z0 + tileSize[2], lv.shape[2]);

    const sel: (number | zarr.Slice)[] = new Array(axisNames.length);
    for (let index = 0; index < axisNames.length; index++) {
      const axis = axisNames[index];
      if (axis === "x") sel[index] = zarr.slice(x0, x1);
      else if (axis === "y") sel[index] = zarr.slice(y0, y1);
      else if (axis === "z") sel[index] = zarr.slice(z0, z1);
      else sel[index] = selection[axis] ?? 0;
    }

    try {
      const result = await zarr.get(arr, sel as any, { opts: { signal } });
      signal?.throwIfAborted();
      return toFloat16(
        result.data as ArrayLike<number>,
        dtype,
        tileSize,
        [x1 - x0, y1 - y0, z1 - z0],
      );
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `fetchTile failed (url ${url}, level ${level}, ` +
        `position [${position.join(", ")}], selection ${JSON.stringify(selection)}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  };

  return {
    dtype,
    name,
    sourceUrl: url,
    omeVersion,
    datasetType,
    datasetMethod,
    datasetDescription,
    pyramid: { levels },
    selectionDims,
    defaultSelection,
    origin,
    spatialUnits,
    omeroChannelLabels,
    omeroChannelColors,
    omeroChannelContrastLimits,
    omeroChannelActives,
    fetchTile,
  };
}

function getDtypeRange(dtype: string): number {
  if (dtype.includes("uint8") || dtype === "|u1" || dtype === "<u1" || dtype === ">u1") return 255;
  if (dtype.includes("uint16") || dtype.includes("<u2") || dtype.includes(">u2")) return 65535;
  if (dtype.includes("int8") || dtype === "|i1" || dtype === "<i1" || dtype === ">i1") return 255;
  if (dtype.includes("int16") || dtype.includes("<i2") || dtype.includes(">i2")) return 65535;
  return 1;
}

export function getNormalizedDisplayContrast(
  window: { min?: number; max?: number; start?: number; end?: number },
  dtypeRange: number,
): [number, number] | undefined {
  const explicit = normalizeContrastPair(window.start, window.end, dtypeRange);
  if (explicit) return explicit;
  return normalizeContrastPair(window.min, window.max, dtypeRange);
}

function normalizeContrastPair(
  minValue: number | undefined,
  maxValue: number | undefined,
  dtypeRange: number,
): [number, number] | undefined {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return undefined;
  const scale = dtypeRange > 0 ? dtypeRange : 1;
  const min = clamp01((minValue as number) / scale);
  const max = clamp01((maxValue as number) / scale);
  return max > min ? [min, max] : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Derive a level's physical voxel scale from the finest level when the level
 * carries no coordinateTransformations of its own.
 */
export function deriveLevelScale(finestScale: Vec3, finestShape: Vec3, levelShape: Vec3): Vec3 {
  return [
    finestScale[0] * finestShape[0] / levelShape[0],
    finestScale[1] * finestShape[1] / levelShape[1],
    finestScale[2] * finestShape[2] / levelShape[2],
  ];
}

// ============================================================================
// FETCH 2D — 2D plane fetcher for OME-Zarr stores
// ============================================================================
//
// Some OME-Zarr arrays hold precomputed 2D projections whose third spatial
// axis indexes one plane per stride along an original axis (e.g. an xz array
// whose y axis indexes one xz projection per stride along the original y
// axis). To render one such plane we need a fetch that:
//   - reads exactly 1 voxel along the through-plane axis at the requested index,
//   - reads a 2D tile along the plane axes,
//   - returns the result already laid out as a plane layer expects
//     (u-fastest, where u = axisMap[0], v = axisMap[1]), transposing when the
//     requested plane orientation reverses the source's natural axis order.
//
// The standard `fetchTile` reads a complete 3D storage chunk. This fetcher
// instead reads one plane through that chunk and retains the storage chunk
// size on the two plane axes.
//
// 3D volume rendering keeps using the standard `fetchTile`; this fetcher
// serves 2D plane views.
//
// It also works on 2D (XY-only) datasets: when the through-plane axis is not
// stored upstream it simply contributes no scalar index, and the requested
// plane index is bounds-checked against the dataset's synthesized singleton
// through-plane shape.

export interface Plane2D {
  /** Underlying adapter info — used for physical transform, channels, scales. */
  info: OMEZarrInfo;
  /** Plane-specific pyramid; through-plane chunks are collapsed to one voxel. */
  pyramid: ImagePyramid;
  /** Custom fetch returning a half-precision r16float buffer ready for a plane layer texture. */
  fetch: (req: {
    level?: number;
    position?: number[];
    selection?: Record<string, number>;
  }) => Promise<ArrayBuffer>;
}

interface ZarrGetResult {
  data: ArrayLike<number>;
}

export async function fetch2DPlane(url: string, axisMap: AxisMap, options?: OMEZarrOptions): Promise<Plane2D> {
  const info = await openOMEZarr(url, options);
  const throughAxis = axisMap[2];

  // Re-open the zarr arrays. `openOMEZarr` doesn't expose them.
  const store = createStore(url, options);
  let root: zarr.Group<zarr.FetchStore>;
  try {
    root = (await zarr.open.v3(store, { kind: "group" })) as zarr.Group<zarr.FetchStore>;
  } catch {
    root = (await zarr.open.v2(store, { kind: "group" })) as zarr.Group<zarr.FetchStore>;
  }
  const ome = (root.attrs as Record<string, unknown>).ome as
    | { multiscales?: Array<{ axes: Array<{ name: string }>; datasets: Array<{ path: string }> }> }
    | undefined;
  const ms =
    ome?.multiscales?.[0] ??
    (
      (root.attrs as Record<string, unknown>).multiscales as Array<{
        axes: Array<{ name: string }>;
        datasets: Array<{ path: string }>;
      }>
    )?.[0];
  if (!ms) throw new Error(`fetch2DPlane: no multiscales in ${url}`);

  const axes = ms.axes; // upstream order, e.g. [c, z, y, x]
  const axisName = (ax: AxisIndex): "x" | "y" | "z" => (ax === 0 ? "x" : ax === 1 ? "y" : "z");
  const storedSpatial = new Set(
    axes.map((a) => a.name).filter((n) => n === "x" || n === "y" || n === "z"),
  );
  // The two plane axes must exist in the array; the through-plane axis may be
  // absent (2D data) — it then simply contributes no scalar index.
  for (const ax of [axisMap[0], axisMap[1]] as AxisIndex[]) {
    if (!storedSpatial.has(axisName(ax))) {
      throw new Error(
        `fetch2DPlane: plane axis "${axisName(ax)}" (axisMap [${axisMap.join(", ")}]) ` +
        `is absent from the dataset axes [${axes.map((a) => a.name).join(", ")}]`,
      );
    }
  }
  const throughStored = storedSpatial.has(axisName(throughAxis));
  const arrays: zarr.Array<zarr.DataType>[] = [];
  for (const ds of ms.datasets) {
    const loc = root.resolve(ds.path);
    let arr: zarr.Array<zarr.DataType>;
    try {
      arr = (await zarr.open.v3(loc, { kind: "array" })) as zarr.Array<zarr.DataType>;
    } catch {
      arr = (await zarr.open.v2(loc, { kind: "array" })) as zarr.Array<zarr.DataType>;
    }
    arrays.push(arr);
  }

  const pyramid: ImagePyramid = {
    levels: info.pyramid.levels.map((level) => {
      const chunkSize = [...level.chunkSize] as Vec3;
      chunkSize[throughAxis] = 1;
      return {
        path: level.path,
        shape: [...level.shape] as Vec3,
        chunkSize,
        scale: [...level.scale] as Vec3,
      };
    }),
  };

  const dtype = info.dtype;

  const fetchPlane = async (req: {
    level?: number;
    position?: number[];
    selection?: Record<string, number>;
    signal?: AbortSignal;
  }): Promise<ArrayBuffer> => {
    const signal = req.signal;
    signal?.throwIfAborted();
    const level = Math.max(0, Math.min(req.level ?? 0, arrays.length - 1));
    const position = req.position ?? [0, 0, 0];
    const selection = req.selection ?? info.defaultSelection;
    const lv = info.pyramid.levels[level];
    const tileXYZ = pyramid.levels[level].chunkSize;
    const totalVoxels = tileXYZ[0] * tileXYZ[1] * tileXYZ[2];
    const arr = arrays[level];

    // Build per-axis selection in upstream axis order.
    // Plane axes: half-open ranges [start, end). Through-plane axis: scalar at
    // the requested plane index. Non-spatial axes (c, t, ...): scalar from selection.
    const sel: (number | zarr.Slice)[] = new Array(axes.length);
    let outOfBounds = false;
    // Through-plane axis not stored upstream (2D data): no scalar index is
    // emitted for it, but the requested plane index is still bounds-checked
    // against the (synthesized, singleton) through-plane shape.
    if (!throughStored) {
      const w = position[throughAxis];
      if (w < 0 || w >= lv.shape[throughAxis]) outOfBounds = true;
    }
    const validShape: Vec3 = [0, 0, 0];
    const resultAxes: AxisIndex[] = [];
    for (let i = 0; i < axes.length && !outOfBounds; i++) {
      const name = axes[i].name;
      if (name === "x" || name === "y" || name === "z") {
        const ax: AxisIndex = name === "x" ? 0 : name === "y" ? 1 : 2;
        const start = position[ax];
        if (ax === throughAxis) {
          if (start < 0 || start >= lv.shape[ax]) {
            outOfBounds = true;
            break;
          }
          sel[i] = start;
        } else {
          if (start < 0 || start >= lv.shape[ax]) {
            outOfBounds = true;
            break;
          }
          const end = Math.min(start + tileXYZ[ax], lv.shape[ax]);
          sel[i] = zarr.slice(start, end);
          validShape[ax] = end - start;
          resultAxes.push(ax);
        }
      } else {
        sel[i] = selection[name] ?? 0;
      }
    }

    if (outOfBounds) return new ArrayBuffer(totalVoxels * 2);

    try {
      const result = await zarr.get(arr, sel as never, { opts: { signal } });
      signal?.throwIfAborted();
      if (!isZarrGetResult(result)) {
        throw new Error("fetch2DPlane: unexpected zarr.get result");
      }
      return packPlaneToFloat16(
        result.data,
        dtype,
        tileXYZ,
        validShape,
        axisMap,
        resultAxes as [AxisIndex, AxisIndex],
      );
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `fetchPlane failed (url ${url}, level ${level}, ` +
        `position [${position.join(", ")}], selection ${JSON.stringify(selection)}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  };

  return { info, pyramid, fetch: fetchPlane };
}

/**
 * Pack a 2D plane (data-row major, u-fastest) into a u-fastest r16float
 * buffer of shape `tileXYZ` (through-plane dim = 1). Shares the dtype
 * encoding of `toFloat16` via `makeFloat16Encoder` from the tile utils.
 */
export function packPlaneToFloat16(
  data: ArrayLike<number>,
  dtype: string,
  tileXYZ: [number, number, number],
  validShape: Vec3,
  axisMap: AxisMap,
  resultAxes: [AxisIndex, AxisIndex],
): ArrayBuffer {
  const [uAxis, vAxis] = axisMap;
  const tileU = tileXYZ[uAxis];
  const tileV = tileXYZ[vAxis];
  const totalVoxels = tileXYZ[0] * tileXYZ[1] * tileXYZ[2];
  const out = new Uint16Array(totalVoxels);
  const validU = Math.max(0, Math.min(validShape[uAxis], tileU));
  const validV = Math.max(0, Math.min(validShape[vAxis], tileV));
  const sourceFastSize = validShape[resultAxes[1]];
  const encode = makeFloat16Encoder(dtype);

  // zarr returns the retained axes in upstream C order. Address by named axis
  // so either natural [v,u] or transposed [u,v] input becomes u-fastest.
  const sourceCoordinate: Vec3 = [0, 0, 0];
  for (let vi = 0; vi < validV; vi++) {
    const dstRow = vi * tileU;
    sourceCoordinate[vAxis] = vi;
    for (let ui = 0; ui < validU; ui++) {
      sourceCoordinate[uAxis] = ui;
      const sourceIndex = sourceCoordinate[resultAxes[0]] * sourceFastSize + sourceCoordinate[resultAxes[1]];
      if (sourceIndex < data.length) {
        out[dstRow + ui] = encode(data[sourceIndex]);
      }
    }
  }
  return out.buffer;
}

function isZarrGetResult(value: unknown): value is ZarrGetResult {
  return typeof value === "object" && value !== null && "data" in value;
}

// ============================================================================
// PLATE — OME-Zarr high-content-screen (HCS / plate) metadata
// ============================================================================
//
// `openOMEZarrPlate` reads plate/well/field layout metadata — never image
// data — and returns a fully typed result: rows, columns, wells (with
// row/column identity and path), and each well's images/fields with a
// `DatasetConfig`-compatible reference per field, so consumers can open a
// field directly through `openDataset({ type: "ome-zarr", source })` (the
// `<plateUrl>/<wellPath>/<fieldPath>` URL convention, e.g.
// `.../9846151.zarr/0`).
//
// Supports OME-Zarr v0.5 (`ome.plate`/`ome.well` attrs) and v0.4
// (`plate`/`well` attrs), mirroring how `openOMEZarr` handles `ome.multiscales`
// vs top-level `multiscales`.

/** A single field (image) of a well, per the OME `well.images` metadata. */
export interface PlateField {
  /** Position of the image in the well's `images` list. */
  index       : number;
  /** Field group path relative to the well group (e.g. "0"). */
  path        : string;
  /** Acquisition id, when the well image carries one. */
  acquisition?: number;
  /**
   * Ready-to-use declarative dataset config for this field — pass it to
   * `openDataset(field.source)` or `openOMEZarr(field.source.source as string)`.
   */
  source      : DatasetConfig;
}

/** A well of the plate, with its resolved fields. */
export interface PlateWell {
  /** Well group path relative to the plate root (e.g. "A/1"). */
  path       : string;
  rowIndex   : number;
  columnIndex: number;
  /** Row name from the plate's `rows` list (e.g. "A"). */
  row        : string;
  /** Column name from the plate's `columns` list (e.g. "1"). */
  column     : string;
  /** The well's fields, in `well.images` order. */
  fields     : PlateField[];
}

/** Typed OME-Zarr plate (HCS) metadata result. */
export interface OMEZarrPlateInfo {
  /** Plate name, when present in the metadata. */
  name?        : string;
  /** URL the plate was opened from (trailing slash stripped). */
  sourceUrl    : string;
  /** OME-Zarr version detected ("0.5" or "0.4"). */
  omeVersion   : string;
  rows         : string[];
  columns      : string[];
  wells        : PlateWell[];
  acquisitions?: Array<{ id: number; name?: string }>;
}

// --- attrs shapes and narrow validators (plain TS, no validation library) ---

interface PlateImageAttrs {
  path        : string;
  acquisition?: number;
}

interface WellAttrs {
  version?: string;
  images? : PlateImageAttrs[];
}

interface PlateWellRef {
  path       : string;
  rowIndex   : number;
  columnIndex: number;
}

interface PlateAttrs {
  version?     : string;
  name?        : string;
  rows?        : Array<{ name: string }>;
  columns?     : Array<{ name: string }>;
  wells?       : PlateWellRef[];
  acquisitions?: Array<{ id: number; name?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlateAttrs(value: unknown): PlateAttrs | undefined {
  if (!isRecord(value)) return undefined;
  const plate: PlateAttrs = {};
  if (typeof value.version === "string") plate.version = value.version;
  if (typeof value.name === "string") plate.name = value.name;
  if (Array.isArray(value.rows)) {
    plate.rows = value.rows.filter(isRecord)
      .filter((row) => typeof row.name === "string")
      .map((row) => ({ name: row.name as string }));
  }
  if (Array.isArray(value.columns)) {
    plate.columns = value.columns.filter(isRecord)
      .filter((column) => typeof column.name === "string")
      .map((column) => ({ name: column.name as string }));
  }
  if (Array.isArray(value.wells)) {
    plate.wells = value.wells.filter(isRecord)
      .filter((well) =>
        typeof well.path === "string" &&
        Number.isInteger(well.rowIndex) &&
        Number.isInteger(well.columnIndex))
      .map((well) => ({
        path       : well.path as string,
        rowIndex   : well.rowIndex as number,
        columnIndex: well.columnIndex as number,
      }));
  }
  if (Array.isArray(value.acquisitions)) {
    plate.acquisitions = value.acquisitions.filter(isRecord)
      .filter((acq) => Number.isInteger(acq.id))
      .map((acq) => ({
        id  : acq.id as number,
        name: typeof acq.name === "string" ? acq.name : undefined,
      }));
  }
  return plate;
}

function parseWellAttrs(value: unknown): WellAttrs | undefined {
  if (!isRecord(value)) return undefined;
  const well: WellAttrs = {};
  if (typeof value.version === "string") well.version = value.version;
  if (Array.isArray(value.images)) {
    well.images = value.images.filter(isRecord)
      .filter((image) => typeof image.path === "string")
      .map((image) => ({
        path       : image.path as string,
        acquisition: Number.isInteger(image.acquisition) ? image.acquisition as number : undefined,
      }));
  }
  return well;
}

function assertSupportedVersion(version: string | undefined, context: string): void {
  if (version === undefined) return;
  if (!/^0\.[45]$/.test(version)) {
    throw new Error(
      `Unsupported OME-Zarr version "${version}" in ${context} (supported: 0.4, 0.5)`,
    );
  }
}

/**
 * Open an OME-Zarr HCS plate and read its full plate/well/field layout.
 *
 * Metadata only — no image chunks are fetched. Accepts the same inputs as
 * `openOMEZarr` (a store URL plus optional `OMEZarrOptions.fetch`).
 */
export async function openOMEZarrPlate(url: string, options?: OMEZarrOptions): Promise<OMEZarrPlateInfo> {
  const baseUrl = url.replace(/\/+$/, "");
  const store   = createStore(url, options);

  let root : zarr.Group<zarr.FetchStore>;
  let isV3 = true;
  try {
    root = await zarr.open.v3(store, { kind: "group" }) as zarr.Group<zarr.FetchStore>;
  } catch {
    isV3 = false;
    try {
      root = await zarr.open.v2(store, { kind: "group" }) as zarr.Group<zarr.FetchStore>;
    } catch (cause) {
      throw new Error(
        `Failed to open OME-Zarr plate store at "${baseUrl}" (tried Zarr v3 and v2): ` +
        `${cause instanceof Error ? cause.message : String(cause)} — check the URL, network, and CORS policy`,
      );
    }
  }

  const attrs    = root.attrs as Record<string, unknown>;
  const omeBlock = attrs.ome as { version?: string; plate?: unknown } | undefined;
  const plate    = parsePlateAttrs(omeBlock?.plate ?? attrs.plate);
  if (!plate || !plate.rows?.length || !plate.columns?.length || !plate.wells) {
    throw new Error(
      `No OME plate metadata found at "${baseUrl}" (checked attrs.ome.plate and attrs.plate) — ` +
      "not an OME-Zarr HCS plate; use openOMEZarr for single multiscale images",
    );
  }
  const omeVersion = omeBlock?.version ?? plate.version ?? (isV3 ? "0.5" : "0.4");
  assertSupportedVersion(omeVersion, `plate metadata at "${baseUrl}"`);

  const rows    = plate.rows.map((row) => row.name);
  const columns = plate.columns.map((column) => column.name);

  const openWell = (wellPath: string): Promise<zarr.Group<zarr.FetchStore>> => {
    const loc = root.resolve(wellPath);
    return (isV3
      ? zarr.open.v3(loc, { kind: "group" })
      : zarr.open.v2(loc, { kind: "group" })) as Promise<zarr.Group<zarr.FetchStore>>;
  };

  const wells: PlateWell[] = await Promise.all(plate.wells.map(async (wellRef) => {
    const row    = rows[wellRef.rowIndex];
    const column = columns[wellRef.columnIndex];
    if (row === undefined || column === undefined) {
      throw new Error(
        `Well "${wellRef.path}" references row ${wellRef.rowIndex}, column ${wellRef.columnIndex}, ` +
        `but the plate declares ${rows.length} rows x ${columns.length} columns`,
      );
    }

    let wellGroup: zarr.Group<zarr.FetchStore>;
    try {
      wellGroup = await openWell(wellRef.path);
    } catch (cause) {
      throw new Error(
        `Failed to open well group "${wellRef.path}" under "${baseUrl}": ` +
        (cause instanceof Error ? cause.message : String(cause)),
      );
    }
    const wellAttrs = wellGroup.attrs as Record<string, unknown>;
    const well      = parseWellAttrs(
      (wellAttrs.ome as { well?: unknown } | undefined)?.well ?? wellAttrs.well,
    );
    if (!well?.images?.length) {
      throw new Error(
        `Well "${wellRef.path}" has no OME well metadata with images ` +
        "(checked attrs.ome.well and attrs.well)",
      );
    }
    assertSupportedVersion(well.version, `well "${wellRef.path}" metadata`);

    const fields: PlateField[] = well.images.map((image, index) => ({
      index,
      path       : image.path,
      acquisition: image.acquisition,
      source     : { type: "ome-zarr", source: `${baseUrl}/${wellRef.path}/${image.path}` },
    }));

    return {
      path       : wellRef.path,
      rowIndex   : wellRef.rowIndex,
      columnIndex: wellRef.columnIndex,
      row,
      column,
      fields,
    };
  }));

  return {
    name        : plate.name,
    sourceUrl   : baseUrl,
    omeVersion,
    rows,
    columns,
    wells,
    acquisitions: plate.acquisitions,
  };
}

// ============================================================================
// IMAGE DATASET — the "ome-zarr" dataset kind
// ============================================================================

/**
 * ImageDataset — the `"ome-zarr"` dataset kind: a single OME-Zarr multiscale
 * image opened from a URL. `load()` normalizes the OME/OMERO metadata onto
 * the base Dataset fields; `pyramid`/`fetch`/`dtype` plug directly into
 * layer `data` configs. Self-registers on module load.
 */
export class ImageDataset extends Dataset {
  /** Multiscale pyramid metadata (populated by `load()`). */
  pyramid : OMEZarrPyramid = { levels: [] };
  /** Tile fetcher — drops into layer `data.fetch` as-is. */
  fetch   : OMEZarrInfo["fetchTile"] = async () => new ArrayBuffer(0);
  /** Source dtype (e.g. `"uint8"`, `"<u2"`). */
  dtype   : string = "";
  /** Physical space derived from the source metadata (always set by `load()`). */
  declare physical: PhysicalSpace;

  /**
   * Store-open options threaded through to `openOMEZarr` during `load()` —
   * runtime-only (never part of the JSON `config`), so
   * {@link openOMEZarrDataset} can open authenticated/custom stores.
   */
  private readonly _options?: OMEZarrOptions;
  private _info?: OMEZarrInfo;

  constructor(config: DatasetConfig, options?: OMEZarrOptions) {
    super(config);
    this._options = options;
  }

  /**
   * The parsed OME-Zarr metadata obtained during `load()`, retained verbatim
   * (API-5): format-specific details — pyramid diagnostics, omero channel
   * metadata, dtype, OME version — stay available without reopening the
   * store. Read-only; undefined until `load()` resolves, released by
   * `dispose()`.
   */
  get info(): OMEZarrInfo | undefined {
    return this._info;
  }

  /**
   * Open the store and populate the normalized metadata fields. A missing
   * `source` is named directly; store open failures keep the underlying
   * message (unsupported metadata vs network/CORS) and add the URL, with the
   * original error preserved as `cause` — never swallowed.
   */
  override async load(): Promise<void> {
    const url: unknown = this.config.source;
    if (typeof url !== "string") {
      throw new Error(
        `ome-zarr dataset config requires a "source" URL string, got: ${JSON.stringify(this.config)}`,
      );
    }
    let info: OMEZarrInfo;
    try {
      info = await openOMEZarr(url, this._options);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed to open OME-Zarr dataset at ${url}: ${message}`, { cause });
    }

    this._info   = info;
    this.pyramid = info.pyramid;
    this.fetch   = info.fetchTile;
    this.dtype   = info.dtype;
    this.name    = info.name;

    const channelDim = info.selectionDims.find((dim) => dim.name === "c");
    const count = Math.max(1, channelDim?.size ?? info.omeroChannelLabels?.length ?? 1);
    const contrastLimits = buildContrastLimits(info.omeroChannelContrastLimits, count);

    const channels: DatasetChannel[] = [];
    for (let index = 0; index < count; index++) {
      channels.push({
        index,
        label   : info.omeroChannelLabels?.[index] ?? channelDim?.labels?.[index] ?? `Channel ${index}`,
        color   : getChannelColor(index, info.omeroChannelColors?.[index]),
        contrast: contrastLimits[index],
        visible : info.omeroChannelActives?.[index] ?? index === 0,
      });
    }
    this.channels = channels;

    this.physical = getPhysicalSpace(info);
    this.dimensions = info.selectionDims.map((dim) => ({
      name: dim.name,
      size: dim.size,
      ...(dim.labels ? { labels: [...dim.labels] } : {}),
    }));
    this.defaultSelection = { ...info.defaultSelection };
    this.capabilities = getDatasetCapabilities(info.pyramid);
  }

  /** Release references held for the layer configs (no stateful resources). */
  override dispose(): void {
    this._info   = undefined;
    this.pyramid = { levels: [] };
    this.fetch   = async () => new ArrayBuffer(0);
    this.dtype   = "";
  }

  override createDefaultLayers(options: DefaultLayersOptions): LayerConfig[] {
    const { view, prefix, axes, channels, projection, transform } = options;
    return channels.map((channel) => ({
      id   : `${prefix}-c${channel.index}`,
      type : view,
      data : {
        pyramid : this.pyramid,
        fetch   : this.fetch,
        ...(transform !== undefined ? { transform: [...transform] } : {}),
      },
      render: {
        visible        : channel.visible,
        color          : channel.color,
        contrastLimits : [...channel.contrast] as [number, number],
        // One layer per channel composites fluorescence-style: additive is
        // the multichannel default for viewer-generated image layers.
        blending       : "additive",
        ...(view === "volume" ? { volumeProjection: projection } : {}),
      },
      options: {
        ...(axes ? { axes: [...axes] } : {}),
        selection: { ...this.defaultSelection, c: channel.index },
      },
    }));
  }
}

/**
 * Open an OME-Zarr store AS a loaded {@link ImageDataset} in one call
 * (API-5): the store's metadata is fetched once and retained on
 * `dataset.info`, so applications that need format metadata before scene
 * construction never pay a second open.
 *
 * The returned instance is CALLER-OWNED — dispose it yourself, or hand it to
 * `viewer.open(dataset)`, which adopts it (ownership transfers at invocation;
 * after that only the Viewer disposes it).
 */
export async function openOMEZarrDataset(
  url: string,
  options?: OMEZarrOptions,
): Promise<ImageDataset> {
  const dataset = new ImageDataset({ type: "ome-zarr", source: url }, options);
  await dataset.load();
  return dataset;
}

registerDataset("ome-zarr", (config) => new ImageDataset(config));
