// @vitest-environment jsdom

import { FUI_THEME, MagnifierOverlay, type State } from '../src/index'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const state = {
  physical: {
    spatial: {
      origin: [0, 0, 0],
      size: [400, 300, 1],
    },
  },
  layers: [],
  exploration: {
    camera: {
      navMode: 'fly',
      projMode: 'orthographic',
      position: [200, 150, 300],
      target: [200, 150, 0],
    },
  },
} satisfies State

describe('Galavi magnifier overlay', () => {
  let overlay: MagnifierOverlay
  let host: HTMLDivElement

  beforeEach(() => {
    const canvas = document.createElement('canvas')
    Object.defineProperties(canvas, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
    })

    host = document.createElement('div')
    host.appendChild(canvas)
    document.body.appendChild(host)

    overlay = new MagnifierOverlay()
    overlay.bindView({
      getViewType: () => 'slice',
      getLayerIds: () => [],
      getCanvas: () => canvas,
      isActive: () => true,
      getAxisMap: () => [0, 1, 2] as const,
      getTheme: () => FUI_THEME,
      getOwner: () => undefined,
    })
    overlay.setOptions({ position: [200, 150, 0], size: 100, zoom: 4 })
    overlay.mount(host)
  })

  afterEach(() => {
    overlay.unmount()
    host.remove()
  })

  it('shows the inset, source footprint, and one nearest-corner leader', () => {
    overlay.render(state)

    const root = host.children[1] as HTMLDivElement
    const shell = root.children[1] as HTMLDivElement
    const source = root.querySelector('rect')
    const leaders = root.querySelectorAll('line')

    expect(root.style.display).toBe('block')
    expect(root.style.width).toBe('400px')
    expect(root.style.height).toBe('300px')
    expect(shell.style.display).toBe('block')
    expect(shell.style.left).toBe('228.5px')
    expect(shell.style.top).toBe('21.5px')
    expect(source?.getAttribute('x')).toBe('187.5')
    expect(source?.getAttribute('y')).toBe('137.5')
    expect(source?.getAttribute('width')).toBe('25')
    expect(source?.getAttribute('height')).toBe('25')
    expect(leaders).toHaveLength(1)
    expect(leaders[0]?.getAttribute('x1')).toBe('212.5')
    expect(leaders[0]?.getAttribute('y1')).toBe('137.5')
    expect(leaders[0]?.getAttribute('x2')).toBe('228.5')
    expect(leaders[0]?.getAttribute('y2')).toBe('121.5')
  })

  it('moves the inset inside the image when the cursor nears an edge', () => {
    overlay.setOptions({ position: [390, 10, 0] })
    overlay.render(state)

    const root = host.children[1] as HTMLDivElement
    const shell = root.children[1] as HTMLDivElement
    const leader = root.querySelector('line')

    expect(shell.style.left).toBe('259px')
    expect(shell.style.top).toBe('41px')
    expect(leader?.getAttribute('x1')).toBe('375')
    expect(leader?.getAttribute('y1')).toBe('25')
    expect(leader?.getAttribute('x2')).toBe('359')
    expect(leader?.getAttribute('y2')).toBe('41')
  })

  it('keeps one connector corner through subpixel edge jitter', () => {
    const shellLeft: number[] = []
    const connectorOffsets: Array<[number, number]> = []

    for (const x of [271.49, 271.51, 271.49, 271.51]) {
      overlay.setOptions({ position: [x, 150, 0] })
      overlay.render(state)

      const root = host.children[1] as HTMLDivElement
      const shell = root.children[1] as HTMLDivElement
      const source = root.querySelector('rect')
      const leader = root.querySelector('line')
      const sourceRight = Number(source?.getAttribute('x')) + Number(source?.getAttribute('width'))
      const insetLeft = Number.parseFloat(shell.style.left)

      shellLeft.push(insetLeft)
      connectorOffsets.push([
        Number(leader?.getAttribute('x1')) - sourceRight,
        Number(leader?.getAttribute('x2')) - insetLeft,
      ])
    }

    expect(Math.max(...shellLeft) - Math.min(...shellLeft)).toBeLessThan(1)
    expect(connectorOffsets).toEqual(Array.from({ length: 4 }, () => [0, 0]))
  })

  it('keeps the current corner through an equal-distance tie', () => {
    overlay.setOptions({ position: [271.49, 150, 0] })
    overlay.render(state)

    const sourceOffsets: number[] = []
    for (const x of [299.99, 300.01, 299.99, 300.01]) {
      overlay.setOptions({ position: [x, 150, 0] })
      overlay.render(state)

      const root = host.children[1] as HTMLDivElement
      const source = root.querySelector('rect')
      const leader = root.querySelector('line')
      const sourceRight = Number(source?.getAttribute('x')) + Number(source?.getAttribute('width'))
      sourceOffsets.push(Number(leader?.getAttribute('x1')) - sourceRight)
    }

    expect(sourceOffsets).toEqual([0, 0, 0, 0])
  })

  it('uses the projected image edge instead of the canvas edge', () => {
    const imageState = structuredClone(state) as State
    imageState.physical = {
      spatial: {
        origin: [100, 50, 0],
        size: [200, 200, 1],
      },
    }
    overlay.setOptions({ position: [290, 60, 0] })
    overlay.render(imageState)

    const root = host.children[1] as HTMLDivElement
    const shell = root.children[1] as HTMLDivElement
    const source = root.querySelector('rect')

    expect(Number.parseFloat(shell.style.left)).toBeCloseTo(159)
    expect(Number.parseFloat(shell.style.top)).toBeCloseTo(91)
    expect(Number.parseFloat(source?.getAttribute('x') ?? '')).toBeCloseTo(275)
    expect(Number.parseFloat(source?.getAttribute('y') ?? '')).toBeCloseTo(50)
    expect(Number.parseFloat(shell.style.left) + 100).toBeLessThanOrEqual(300)
  })

  it('derives every follow camera from the parent view', () => {
    let nestedState = structuredClone(state) as State
    Object.assign(overlay, {
      nested: {
        getState: () => structuredClone(nestedState),
        setState: (next: State) => { nestedState = next },
        requestRender: () => undefined,
        destroy: () => undefined,
      },
    })

    overlay.render(state)
    expect(nestedState.exploration.camera.target).toEqual([200, 150, 0])
    expect(nestedState.exploration.camera.position).toEqual([200, 150, 25])

    overlay.setOptions({ position: [210, 150, 0] })
    overlay.render(state)
    expect(nestedState.exploration.camera.target).toEqual([210, 150, 0])
    expect(nestedState.exploration.camera.position).toEqual([210, 150, 25])
  })

  it('mirrors a current-channel change on an existing layer', () => {
    const initialChannelState: State = {
      ...structuredClone(state),
      layers: [{
        id: 'volume',
        type: 'volume',
        options: { selection: { c: 0 } },
        render: { visible: true, color: '#FF0000', contrastLimits: [0, 1] },
      }],
    }
    let nestedState = structuredClone(initialChannelState)
    Object.assign(overlay, {
      nested: {
        getState: () => structuredClone(nestedState),
        setState: (next: State) => { nestedState = next },
        requestRender: () => undefined,
        destroy: () => undefined,
      },
    })

    overlay.render(initialChannelState)
    overlay.render({
      ...structuredClone(state),
      layers: [{
        id: 'volume',
        type: 'volume',
        options: { selection: { c: 2 } },
        render: { visible: true, color: '#0000FF', contrastLimits: [0.2, 0.7] },
      }],
    })

    expect(nestedState.layers[0]).toMatchObject({
      id: 'volume',
      options: { selection: { c: 2 } },
      render: { visible: true, color: '#0000FF', contrastLimits: [0.2, 0.7] },
    })
  })

  it('mirrors the current channel selection and visible channel composition', () => {
    const initialChannelState: State = {
      ...structuredClone(state),
      layers: [
        {
          id: 'slice:c0',
          type: 'slice',
          options: { selection: { c: 0 } },
          render: { visible: true, color: '#FF0000', contrastLimits: [0, 1] },
        },
        {
          id: 'slice:c1',
          type: 'slice',
          options: { selection: { c: 1 } },
          render: { visible: false, color: '#00FF00', contrastLimits: [0, 1] },
        },
      ],
    }
    let nestedState = structuredClone(initialChannelState)
    Object.assign(overlay, {
      nested: {
        getState: () => structuredClone(nestedState),
        setState: (next: State) => { nestedState = next },
        requestRender: () => undefined,
        destroy: () => undefined,
      },
    })

    overlay.render(initialChannelState)
    overlay.render({
      ...structuredClone(state),
      layers: [
        {
          id: 'slice:c0',
          type: 'slice',
          options: { selection: { c: 0 } },
          render: { visible: false, color: '#FF0000', contrastLimits: [0.1, 0.4] },
        },
        {
          id: 'slice:c1',
          type: 'slice',
          options: { selection: { c: 1 } },
          render: { visible: true, color: '#00FF00', contrastLimits: [0.2, 0.8] },
        },
      ],
    })

    expect(nestedState.layers).toMatchObject([
      {
        id: 'slice:c0',
        options: { selection: { c: 0 } },
        render: { visible: false, color: '#FF0000', contrastLimits: [0.1, 0.4] },
      },
      {
        id: 'slice:c1',
        options: { selection: { c: 1 } },
        render: { visible: true, color: '#00FF00', contrastLimits: [0.2, 0.8] },
      },
    ])
  })
})