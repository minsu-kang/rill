// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clampText, markHidden } from '../src/chat/model/clamp'

describe('markHidden', () => {
  it('replaces control, format and separator characters with a visible marker', () => {
    expect(markHidden('a\u0007b‮c​d e')).toBe('a‹U+0007›b‹U+202E›c‹U+200B›d‹U+2028›e')
  })

  it('keeps ordinary text, emoji with a joiner replaced, and new lines when asked to', () => {
    expect(markHidden('plain 텍스트 text')).toBe('plain 텍스트 text')
    expect(markHidden('a\nb\tc', { keepLayout: true })).toBe('a\nb\tc')
    expect(markHidden('a\nb')).toBe('a‹U+000A›b')
  })
})

describe('clampText', () => {
  it('returns short text whole', () => {
    expect(clampText('abc', 10)).toEqual({ shown: 'abc', cut: false })
  })

  it('cuts long text at the limit with an ellipsis and says so', () => {
    const out = clampText('x'.repeat(50), 10)
    expect(out.cut).toBe(true)
    expect(out.shown.length).toBe(10)
    expect(out.shown.endsWith('…')).toBe(true)
  })

  it('does not split a surrogate pair', () => {
    const out = clampText('😀'.repeat(20), 5)
    expect(/[\ud800-\udbff]…$/.test(out.shown)).toBe(false)
  })
})
