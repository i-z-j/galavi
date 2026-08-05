import { afterEach, describe, expect, test, vi } from "vitest";
import { TilePool } from "../src/utils/tile";

describe("TilePool index capacity", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("grows independently of resident tile capacity", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2 });
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });

    const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      limits: {
        maxTextureDimension3D: 2048,
        maxStorageBufferBindingSize: 1024,
        maxBufferSize: 1024,
      },
      createTexture: () => ({ createView: () => ({}), destroy: vi.fn() }),
      createBuffer: ({ size }: { size: number }) => {
        const buffer = { size, destroy: vi.fn() };
        buffers.push(buffer);
        return buffer;
      },
      queue: {
        writeBuffer: vi.fn(),
        writeTexture: vi.fn(),
        onSubmittedWorkDone: () => Promise.resolve(),
      },
    } as unknown as GPUDevice;
    const pool = new TilePool({
      device,
      slotSize: [1, 1, 1],
      maxPoolSize: 4,
    });
    const initial = pool.indexBuffer as unknown as (typeof buffers)[number];

    expect(pool.capacity).toBe(4);
    expect(initial.size).toBe(32);
    expect(pool.ensureIndexCapacity(5)).toBe(true);
    expect(pool.indexBuffer).not.toBe(initial);
    expect((pool.indexBuffer as unknown as (typeof buffers)[number]).size).toBe(64);
    expect(pool.ensureIndexCapacity(6)).toBe(false);

    await Promise.resolve();
    expect(initial.destroy).toHaveBeenCalledOnce();
    pool.destroy();
  });
});