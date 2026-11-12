// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { escapeInvisible, invisibleLabel, splitInvisible } from '../src/model/text'

describe('invisibleLabel', () => {
  it('writes the code point with at least four upper case hex digits', () => {
    expect(invisibleLabel('‮')).toBe('U+202E')
    expect(invisibleLabel('​')).toBe('U+200B')
    expect(invisibleLabel('­')).toBe('U+00AD')
    expect(invisibleLabel('\u{e0067}')).toBe('U+E0067')
  })
})

describe('splitInvisible', () => {
  it('returns one visible part for text without format characters and none for the empty string', () => {
    expect(splitInvisible('plain text')).toEqual([{ text: 'plain text', invisible: false }])
    expect(splitInvisible('')).toEqual([])
  })

  it('separates every bidi, zero width and byte order mark character, in order', () => {
    expect(splitInvisible('a‮b​c﻿')).toEqual([
      { text: 'a', invisible: false },
      { text: '‮', invisible: true },
      { text: 'b', invisible: false },
      { text: '​', invisible: true },
      { text: 'c', invisible: false },
      { text: '﻿', invisible: true },
    ])
    expect(splitInvisible('⁦⁩')).toEqual([
      { text: '⁦', invisible: true },
      { text: '⁩', invisible: true },
    ])
  })

  it('treats every character of the ranges the review named as invisible', () => {
    const ranges: Array<[number, number]> = [
      [0x200b, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff],
    ]
    for (const [from, to] of ranges) {
      for (let code = from; code <= to; code += 1) expect(splitInvisible(String.fromCodePoint(code)), code.toString(16)).toEqual([{ text: String.fromCodePoint(code), invisible: true }])
    }
  })

  it('keeps ordinary letters, digits, spaces, emoji and Korean visible', () => {
    for (const text of ['abc 123', '한국어 텍스트', '😀', '\t', ' ']) expect(splitInvisible(text)).toEqual([{ text, invisible: false }])
  })

  it('keeps a character outside the basic plane together', () => {
    expect(splitInvisible('x\u{e0067}y')).toEqual([
      { text: 'x', invisible: false },
      { text: '\u{e0067}', invisible: true },
      { text: 'y', invisible: false },
    ])
  })
})

describe('escapeInvisible', () => {
  it('writes each hidden character as a visible code point and leaves other text alone', () => {
    expect(escapeInvisible('invoice ‮txt.exe')).toBe('invoice ‹U+202E›txt.exe')
    expect(escapeInvisible('a​b​c')).toBe('a‹U+200B›b‹U+200B›c')
    expect(escapeInvisible('plain')).toBe('plain')
    expect(escapeInvisible('')).toBe('')
  })

  it('leaves no format character behind', () => {
    expect(escapeInvisible('‪‫‬‭‮⁦⁧⁨⁩‎‏﻿')).not.toMatch(/\p{Cf}/u)
  })
})
