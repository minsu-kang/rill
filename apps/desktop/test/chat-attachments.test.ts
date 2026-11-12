// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ko } from '../src/i18n/ko'
import { en } from '../src/i18n/en'
import { ATTACHMENT_LIMITS, attachmentReasonKey, checkAttachment, mediaTypeOf, safeName, type AttachmentReason } from '../src/chat/model/attachments'

const NONE = { inMessage: 0, inConversation: 0 }
const MIB = 1024 * 1024

describe('mediaTypeOf', () => {
  it('accepts every allowed type by its declared type', () => {
    for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'text/markdown']) {
      expect(mediaTypeOf({ name: 'file', type })).toBe(type)
    }
  })

  it('reads the declared type without its parameters and in any case', () => {
    expect(mediaTypeOf({ name: 'a', type: 'Text/Plain; charset=utf-8' })).toBe('text/plain')
    expect(mediaTypeOf({ name: 'a', type: ' IMAGE/PNG ' })).toBe('image/png')
  })

  it('falls back to the extension when the browser declares nothing or something else', () => {
    const cases: Array<[string, string, string | undefined]> = [
      ['a.pdf', '', 'application/pdf'],
      ['a.PNG', '', 'image/png'],
      ['a.jpg', '', 'image/jpeg'],
      ['a.jpeg', '', 'image/jpeg'],
      ['a.gif', '', 'image/gif'],
      ['a.webp', '', 'image/webp'],
      ['a.txt', '', 'text/plain'],
      ['a.csv', 'application/vnd.ms-excel', 'text/csv'],
      ['a.md', 'text/x-markdown', 'text/markdown'],
      ['a.markdown', '', 'text/markdown'],
    ]
    for (const [name, type, expected] of cases) expect(mediaTypeOf({ name, type }), name).toBe(expected)
  })

  it('refuses a type it does not know, and a name with no extension', () => {
    expect(mediaTypeOf({ name: 'a.zip', type: 'application/zip' })).toBeUndefined()
    expect(mediaTypeOf({ name: 'a.svg', type: 'image/svg+xml' })).toBeUndefined()
    expect(mediaTypeOf({ name: 'a.exe', type: '' })).toBeUndefined()
    expect(mediaTypeOf({ name: 'pdf', type: '' })).toBeUndefined()
    expect(mediaTypeOf({ name: '', type: '' })).toBeUndefined()
  })

  it('lets the declared type win over the extension', () => {
    expect(mediaTypeOf({ name: 'a.pdf', type: 'image/png' })).toBe('image/png')
  })
})

describe('ATTACHMENT_LIMITS', () => {
  it('holds the limits of the spec', () => {
    expect(ATTACHMENT_LIMITS).toEqual({ pdfBytes: 20 * MIB, imageBytes: 3.75 * MIB, textBytes: MIB, perMessage: 5, perConversation: 10 })
  })
})

describe('checkAttachment', () => {
  it('accepts a file of each type at its limit and refuses one byte more', () => {
    const cases: Array<[string, number]> = [
      ['application/pdf', ATTACHMENT_LIMITS.pdfBytes],
      ['image/png', ATTACHMENT_LIMITS.imageBytes],
      ['image/jpeg', ATTACHMENT_LIMITS.imageBytes],
      ['image/gif', ATTACHMENT_LIMITS.imageBytes],
      ['image/webp', ATTACHMENT_LIMITS.imageBytes],
      ['text/plain', ATTACHMENT_LIMITS.textBytes],
      ['text/csv', ATTACHMENT_LIMITS.textBytes],
      ['text/markdown', ATTACHMENT_LIMITS.textBytes],
    ]
    for (const [type, limit] of cases) {
      expect(checkAttachment({ name: 'f', type, size: limit }, NONE), type).toEqual({ ok: true, mediaType: type })
      expect(checkAttachment({ name: 'f', type, size: limit + 1 }, NONE), type).toEqual({ ok: false, reason: 'too_large' })
    }
  })

  it('refuses an empty file and an unsupported type', () => {
    expect(checkAttachment({ name: 'a.txt', type: 'text/plain', size: 0 }, NONE)).toEqual({ ok: false, reason: 'empty' })
    expect(checkAttachment({ name: 'a.zip', type: 'application/zip', size: 10 }, NONE)).toEqual({ ok: false, reason: 'unsupported_type' })
    expect(checkAttachment({ name: 'a.zip', type: 'application/zip', size: 0 }, NONE)).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('counts the files of the message and of the conversation', () => {
    const file = { name: 'a.txt', type: 'text/plain', size: 5 }
    expect(checkAttachment(file, { inMessage: 4, inConversation: 4 }).ok).toBe(true)
    expect(checkAttachment(file, { inMessage: 5, inConversation: 5 })).toEqual({ ok: false, reason: 'too_many_in_message' })
    expect(checkAttachment(file, { inMessage: 0, inConversation: 9 }).ok).toBe(true)
    expect(checkAttachment(file, { inMessage: 0, inConversation: 10 })).toEqual({ ok: false, reason: 'too_many_in_conversation' })
    expect(checkAttachment(file, { inMessage: 5, inConversation: 10 })).toEqual({ ok: false, reason: 'too_many_in_message' })
  })

  it('reads the type from the extension when the browser declares none', () => {
    expect(checkAttachment({ name: 'receipt.PDF', type: '', size: 5 }, NONE)).toEqual({ ok: true, mediaType: 'application/pdf' })
  })
})

describe('safeName', () => {
  it('leaves an ordinary name alone', () => {
    expect(safeName('receipt 2026-11.pdf')).toEqual({ shown: 'receipt 2026-11.pdf', changed: false })
    expect(safeName('영수증 사본.pdf')).toEqual({ shown: '영수증 사본.pdf', changed: false })
  })

  it('shows a right-to-left override, a zero-width joiner and control characters as markers', () => {
    const reversed = safeName('invoice‮gpj.exe')
    expect(reversed.changed).toBe(true)
    expect(reversed.shown).toBe('invoice‹U+202E›gpj.exe')
    expect(safeName('a‍b').shown).toBe('a‹U+200D›b')
    expect(safeName('a\u0007b\u001Bc').shown).toBe('a‹U+0007›b‹U+001B›c')
    expect(safeName('a b').shown).toBe('a‹U+2028›b')
    expect(safeName('a​b⁦c­d').shown).toBe('a‹U+200B›b‹U+2066›c‹U+00AD›d')
  })

  it('never returns an invisible character', () => {
    const shown = safeName('x‮​\u0000\u007Fy﻿').shown
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(shown)).toBe(false)
  })

  it('cuts a 300 character name and keeps the full text on request', () => {
    const long = `${'a'.repeat(299)}b`
    const short = safeName(long)
    expect(short.changed).toBe(true)
    expect(short.shown.length).toBeLessThan(long.length)
    expect(short.shown.endsWith('…')).toBe(true)
    expect(safeName(long, Infinity)).toEqual({ shown: long, changed: false })
  })

  it('does not cut in the middle of a surrogate pair', () => {
    const shown = safeName('😀'.repeat(100), 11).shown
    expect(shown.endsWith('…')).toBe(true)
    expect(/[\ud800-\udbff]…$/.test(shown)).toBe(false)
  })

  it('never returns an empty name', () => {
    for (const name of ['', '   ', '\t']) {
      const result = safeName(name)
      expect(result.shown).not.toBe('')
      expect(result.shown.trim()).not.toBe('')
      expect(result.changed).toBe(true)
    }
  })
})

describe('attachmentReasonKey', () => {
  it('has a distinct message in both languages for every reason', () => {
    const reasons: AttachmentReason[] = ['unsupported_type', 'too_large', 'too_many_in_message', 'too_many_in_conversation', 'empty']
    const keys = reasons.map(attachmentReasonKey)
    expect(new Set(keys).size).toBe(reasons.length)
    for (const key of keys) {
      expect(ko).toHaveProperty([key])
      expect(en).toHaveProperty([key])
    }
  })
})
