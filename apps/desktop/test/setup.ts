import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    setTimeout(() => {
      this.callback([{ target } as ResizeObserverEntry], this)
    }, 0)
  }

  unobserve(): void {}

  disconnect(): void {}
}

class DOMMatrixReadOnlyStub {
  m22: number

  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.])\)/)?.[1]
    this.m22 = scale === undefined ? 1 : Number(scale)
  }
}

if (typeof window !== 'undefined') {
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub, DOMMatrixReadOnly: DOMMatrixReadOnlyStub })
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 1
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 1
      },
    },
  })
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  })
}

afterEach(() => {
  cleanup()
})
