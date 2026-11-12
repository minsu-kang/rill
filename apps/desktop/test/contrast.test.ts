// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { contrastRatio, luminance, parseHex } from './contrast'

describe('parseHex', () => {
  it('reads six and three digit colors in either case', () => {
    expect(parseHex('#ff8000')).toEqual([255, 128, 0])
    expect(parseHex('#FF8000')).toEqual([255, 128, 0])
    expect(parseHex('#fff')).toEqual([255, 255, 255])
    expect(parseHex('#a1c')).toEqual([170, 17, 204])
    expect(parseHex('  #0a0b0c ')).toEqual([10, 11, 12])
  })

  it('throws for anything else', () => {
    for (const bad of ['red', '#12', '#12345', '#1234567', '#12345g', 'ff8000', '', '#ffff']) expect(() => parseHex(bad), bad).toThrow('not a hex color')
  })
})

describe('luminance', () => {
  it('weights the three channels as the standard does', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 10)
    expect(luminance('#ff0000')).toBeCloseTo(0.2126, 6)
    expect(luminance('#00ff00')).toBeCloseTo(0.7152, 6)
    expect(luminance('#0000ff')).toBeCloseTo(0.0722, 6)
  })

  it('uses the linear part for very dark channels and the curve above it', () => {
    expect(luminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 6)
    expect(luminance('#808080')).toBeCloseTo(0.2158605, 6)
    expect(luminance('#0b0b0b')).toBeCloseTo(0.0033465, 6)
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white, 1 for equal colors, and the same in both directions', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10)
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 10)
  })

  it('matches known values', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478, 3)
    expect(contrastRatio('#ff0000', '#000000')).toBeCloseTo(5.252, 3)
    expect(contrastRatio('#00ff00', '#000000')).toBeCloseTo(15.304, 3)
    expect(contrastRatio('#0000ff', '#000000')).toBeCloseTo(2.444, 3)
    expect(contrastRatio('#0a0a0a', '#000000')).toBeCloseTo(1.0607, 4)
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })
})
