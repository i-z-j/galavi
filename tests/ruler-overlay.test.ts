// @vitest-environment jsdom

import { FUI_THEME, RulerOverlay, type State } from '../src/advanced'
import { afterEach, describe, expect, it } from 'vitest'

describe('Galavi ruler overlay', () => {
  let overlay: RulerOverlay | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    overlay?.unmount()
    host?.remove()
  })

  it('uses bar handles and defaults to the upper-right', () => {
    const canvas = document.createElement('canvas')
    Object.defineProperties(canvas, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
    })
    host = document.createElement('div')
    document.body.appendChild(host)

    overlay = new RulerOverlay()
    overlay.bindView({
      getViewType: () => 'test',
      getLayerIds: () => [],
      getCanvas: () => canvas,
      isActive: () => true,
      getAxisMap: () => undefined,
      getTheme: () => FUI_THEME,
      getOwner: () => undefined,
    })
    overlay.mount(host)
    overlay.render({
      layers: [],
      exploration: {
        camera: {
          navMode: 'fly',
          projMode: 'orthographic',
          position: [0, 0, 1],
          target: [0, 0, 0],
        },
      },
    } satisfies State)

    const line = host.querySelector('svg > line:nth-of-type(2)')
    const bars = host.querySelectorAll('svg > g > line')
    expect(line?.getAttribute('x1')).toBe('230')
    expect(line?.getAttribute('x2')).toBe('330')
    expect(line?.getAttribute('y1')).toBe('37.5')
    expect(bars).toHaveLength(2)
    expect(bars[0]?.tagName).toBe('line')
    expect(bars[0]?.getAttribute('x1')).toBe('230')
    expect(bars[0]?.getAttribute('x2')).toBe('230')
    expect(bars[0]?.getAttribute('y1')).toBe('31.5')
    expect(bars[0]?.getAttribute('y2')).toBe('43.5')
    expect(bars[1]?.getAttribute('x1')).toBe('330')
    expect(bars[1]?.getAttribute('x2')).toBe('330')
  })
})