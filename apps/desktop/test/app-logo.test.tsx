import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Logo } from '../src/app/Logo'
import { DOT_NODE, DROP_PATH, SPLIT_NODES, SPLIT_PATHS } from '../src/app/logo-geometry'

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('no svg')
  return svg
}

describe('Logo', () => {
  it('is decorative: hidden from assistive technology, not focusable, no title or text', () => {
    const svg = svgOf(render(<Logo />).container)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.querySelector('title')).toBeNull()
    expect(svg.textContent).toBe('')
  })

  it('draws the drop and the split stream with both nodes at 32 px and above', () => {
    const svg = svgOf(render(<Logo size={32} />).container)
    expect(svg.getAttribute('data-rill-logo')).toBe('full')
    expect(svg.getAttribute('width')).toBe('32')
    expect(svg.getAttribute('viewBox')).toBe('0 0 512 512')
    const paths = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d'))
    expect(paths).toEqual([DROP_PATH, ...SPLIT_PATHS])
    const circles = [...svg.querySelectorAll('circle')].map((circle) => ({ cx: Number(circle.getAttribute('cx')), cy: Number(circle.getAttribute('cy')), r: Number(circle.getAttribute('r')) }))
    expect(circles).toEqual(SPLIT_NODES.map((node) => ({ ...node })))
  })

  it('uses the simple drop with one dot at 24 px and below', () => {
    for (const size of [16, 24]) {
      const svg = svgOf(render(<Logo size={size} />).container)
      expect(svg.getAttribute('data-rill-logo')).toBe('small')
      expect([...svg.querySelectorAll('path')].map((path) => path.getAttribute('d'))).toEqual([DROP_PATH])
      const circles = svg.querySelectorAll('circle')
      expect(circles).toHaveLength(1)
      expect(Number(circles[0]!.getAttribute('r'))).toBe(DOT_NODE.r)
    }
  })

  it('lets the variant prop override the size rule', () => {
    expect(svgOf(render(<Logo size={96} variant="small" />).container).getAttribute('data-rill-logo')).toBe('small')
    expect(svgOf(render(<Logo size={16} variant="full" />).container).getAttribute('data-rill-logo')).toBe('full')
  })

  it('takes its colours from the theme tokens and carries no inline style, which the page policy forbids', () => {
    const svg = svgOf(render(<Logo size={48} />).container)
    expect(svg.querySelector('[style]')).toBeNull()
    expect(svg.getAttribute('style')).toBeNull()
  })
})
