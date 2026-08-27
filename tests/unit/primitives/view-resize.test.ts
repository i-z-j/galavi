/**
 * Canvas auto-resize tests.
 *
 * BaseView owns a guarded ResizeObserver on the bound canvas: a content-box
 * change resizes the backing store, fires onViewportChanged, and requests a
 * render. `ViewConfig.autoResize: false` opts out. Runs headless with a
 * stubbed ResizeObserver / window / navigator.gpu and a fake canvas.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { State } from "../../../src/state/schema";
import type { ViewerRuntime } from "../../../src/viewer";
import { BaseView } from "../../../src/primitives/view";

class TestView extends BaseView {
  static readonly viewType = "test";
  viewportChanges = 0;

  protected async initGPUResources(): Promise<void> {}
  protected override onLayersChanged(): void {}
  protected renderFrame(_state: State): void {}
  protected override onViewportChanged(): void {
    this.viewportChanges++;
  }
}

type ObserverInstance = {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
};

function makeCanvas(width: number, height: number) {
  return {
    clientWidth  : width,
    clientHeight : height,
    width        : 0,
    height       : 0,
    parentElement: null,
    style        : {} as CSSStyleDeclaration,
    setAttribute : () => {},
    hasAttribute : () => false,
    getContext   : () => ({
      configure  : () => {},
      unconfigure: () => {},
    }),
  } as unknown as HTMLCanvasElement;
}

describe("BaseView canvas auto-resize", () => {
  let observers: ObserverInstance[];
  let requestRender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observers = [];
    requestRender = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      callback: ResizeObserverCallback;
      instance: ObserverInstance;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        this.instance = { callback, observed: [], disconnected: false };
        observers.push(this.instance);
      }
      observe(target: Element) { this.instance.observed.push(target); }
      unobserve(target: Element) {
        this.instance.observed = this.instance.observed.filter((t) => t !== target);
      }
      disconnect() { this.instance.disconnected = true; }
    });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("navigator", {
      gpu: { getPreferredCanvasFormat: () => "bgra8unorm" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mountView(autoResize = true) {
    const view = new TestView("v1");
    view.autoResize = autoResize;
    view.setOwner({ requestRender } as unknown as ViewerRuntime);
    view.setDevice({} as GPUDevice);
    const canvas = makeCanvas(100, 50);
    await view.mount(canvas);
    return { view, canvas };
  }

  function fireResize() {
    for (const observer of observers) {
      observer.callback(
        [] as unknown as ResizeObserverEntry[],
        observer as unknown as ResizeObserver,
      );
    }
  }

  test("content-box change resizes, fires onViewportChanged, requests render", async () => {
    const { view, canvas } = await mountView();
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toContain(canvas);
    expect(view.viewportChanges).toBe(0);

    (canvas as { clientWidth: number }).clientWidth = 200;
    fireResize();

    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(50);
    expect(view.viewportChanges).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  test("unchanged size still requests a render but skips the viewport hook", async () => {
    const { view } = await mountView();
    fireResize();

    expect(view.viewportChanges).toBe(0);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  test("autoResize: false opts out of observation", async () => {
    const { view } = await mountView(false);
    expect(observers).toHaveLength(0);
    expect(view.viewportChanges).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
  });

  test("unmount disconnects the observer", async () => {
    const { view } = await mountView();
    view.unmount();
    expect(observers[0]!.disconnected).toBe(true);
  });
});
