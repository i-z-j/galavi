// @vitest-environment jsdom

import { FUI_THEME, RoiSelectorOverlay, type State } from '../src/index'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state: State = {
  layers: [],
  exploration: {
    camera: {
      navMode: 'fly',
      projMode: 'orthographic',
      position: [50, 50, 150],
      target: [50, 50, 50],
    },
  },
  physical: {
    spatial: {
      size: [100, 100, 100],
      origin: [0, 0, 0],
      unit: 'µm',
    },
  },
}

describe('Galavi ROI selector overlay', () => {
  let overlay: RoiSelectorOverlay | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    overlay?.unmount()
    host?.remove()
  })

  function mountOverlay() {
    const canvas = document.createElement('canvas')
    Object.defineProperties(canvas, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
    })
    host = document.createElement('div')
    document.body.appendChild(host)

    overlay = new RoiSelectorOverlay()
    overlay.bindView({
      getViewType: () => 'slice',
      getLayerIds: () => [],
      getCanvas: () => canvas,
      isActive: () => true,
      getAxisMap: () => [0, 1, 2],
      getTheme: () => FUI_THEME,
      getOwner: () => undefined,
    })
    overlay.mount(host)
    overlay.setOptions({ rois: [{ min: [10, 20, 30], max: [40, 50, 60] }], activeIndex: 0 })
    overlay.render(state)
    return canvas
  }

  it('uses the theme accent and shows unitless ranges on three lines', () => {
    mountOverlay()

    const body = host?.querySelector('svg g rect') as SVGRectElement | null
    const labelText = host?.querySelector('div > span')
    expect(body?.style.stroke).toBe('var(--galavi-accent)')
    expect(labelText?.textContent).toBe('X 10.0 - 40.0\nY 20.0 - 50.0\nZ 30.0 - 60.0')
  })

  it('forwards wheel input to the canvas for zooming', () => {
    const canvas = mountOverlay()
    const onWheel = vi.fn((event: WheelEvent) => event.preventDefault())
    canvas.addEventListener('wheel', onWheel)

    const source = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 24 })
    host?.querySelector('svg')?.dispatchEvent(source)

    expect(onWheel).toHaveBeenCalledOnce()
    expect((onWheel.mock.calls[0]?.[0] as WheelEvent).deltaY).toBe(24)
    expect(source.defaultPrevented).toBe(true)
  })

  it('activates and removes individual selections', () => {
    mountOverlay()
    const onActiveIndexChange = vi.fn()
    const onRoisChange = vi.fn()
    overlay?.setOptions({
      rois: [
        { min: [10, 20, 30], max: [40, 50, 60] },
        { min: [55, 15, 20], max: [80, 45, 70] },
      ],
      activeIndex: 0,
      onActiveIndexChange,
      onRoisChange,
    })
    overlay?.render(state)

    const labels = Array.from(host?.querySelectorAll('button[aria-label="Copy physical range"]') ?? [])
      .map((button) => button.parentElement?.querySelector('span')?.textContent)
    expect(labels).toEqual([
      'X 10.0 - 40.0\nY 20.0 - 50.0\nZ 30.0 - 60.0',
      'X 55.0 - 80.0\nY 15.0 - 45.0\nZ 20.0 - 70.0',
    ])

    const bodies = host?.querySelectorAll('svg > g > rect:first-child') ?? []
    bodies[1]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    overlay?.render(state)

    expect(onActiveIndexChange).toHaveBeenCalledWith(1)
    expect((bodies[0]?.parentElement?.children[1] as SVGRectElement).style.display).toBe('none')
    expect((bodies[1]?.parentElement?.children[1] as SVGRectElement).style.display).toBe('')

    const removeButtons = host?.querySelectorAll('button[aria-label="Remove selection"]') ?? []
    ;(removeButtons[1] as HTMLButtonElement | undefined)?.click()

    expect(onRoisChange).toHaveBeenCalledWith(
      [{ min: [10, 20, 30], max: [40, 50, 60] }],
      { index: 1, kind: 'remove', phase: 'commit' },
    )
  })

  it('uses the bound view projection for volume wireframes', () => {
    const canvas = document.createElement('canvas')
    Object.defineProperties(canvas, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    const projectPhysicalToScreen = vi.fn(() => [123, 45] as [number, number])

    overlay = new RoiSelectorOverlay()
    overlay.bindView({
      getViewType: () => 'volume',
      getLayerIds: () => [],
      getCanvas: () => canvas,
      isActive: () => true,
      getAxisMap: () => undefined,
      getTheme: () => FUI_THEME,
      getOwner: () => undefined,
      projectPhysicalToScreen,
    })
    overlay.mount(host)
    overlay.setOptions({ rois: [{ min: [10, 20, 30], max: [40, 50, 60] }] })
    overlay.render(state)

    const edge = host.querySelector('svg g line')
    expect(projectPhysicalToScreen).toHaveBeenCalledTimes(8)
    expect(edge?.getAttribute('x1')).toBe('123')
    expect(edge?.getAttribute('y1')).toBe('45')
  })
})