import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, MEMORY_MAX_CHARS, MEMORY_MAX_INPUT_CHARS, MEMORY_MAX_ITEMS, METHODS, MemoryItemSchema, validateParams } from '../src/index'

const item = { id: '3f2b8c1e-6a4d-4f5b-9c0e-1a2b3c4d5e6f', text: 'My receipts live in ~/Receipts', createdAt: 1000, updatedAt: 2000 }

describe('memory limits', () => {
  it('are 20 notes of 300 characters', () => {
    expect(MEMORY_MAX_ITEMS).toBe(20)
    expect(MEMORY_MAX_CHARS).toBe(300)
    expect(MEMORY_MAX_INPUT_CHARS).toBeGreaterThan(MEMORY_MAX_CHARS)
  })
})

describe('MemoryItemSchema', () => {
  const valid = (value: unknown) => Value.Check(MemoryItemSchema, value)

  it('accepts a note of 1 to 300 characters', () => {
    expect(valid(item)).toBe(true)
    expect(valid({ ...item, text: 'x' })).toBe(true)
    expect(valid({ ...item, text: 'x'.repeat(300) })).toBe(true)
  })

  it('counts characters, not UTF-16 units', () => {
    expect(valid({ ...item, text: '😀'.repeat(300) })).toBe(true)
    expect(valid({ ...item, text: '😀'.repeat(301) })).toBe(false)
  })

  it('rejects empty and over-long text', () => {
    expect(valid({ ...item, text: '' })).toBe(false)
    expect(valid({ ...item, text: 'x'.repeat(301) })).toBe(false)
  })

  it('rejects extra properties, missing fields and wrong types', () => {
    expect(valid({ ...item, extra: 1 })).toBe(false)
    for (const key of ['id', 'text', 'createdAt', 'updatedAt'] as const) {
      const rest: Record<string, unknown> = { ...item }
      delete rest[key]
      expect(valid(rest), key).toBe(false)
    }
    expect(valid({ ...item, id: '' })).toBe(false)
    expect(valid({ ...item, text: 7 })).toBe(false)
    expect(valid({ ...item, createdAt: '1' })).toBe(false)
    expect(valid({ ...item, updatedAt: null })).toBe(false)
  })
})

describe('listMemory', () => {
  it('takes no params', () => {
    expect(validateParams('listMemory', {})).toEqual({ ok: true, method: 'listMemory', params: {} })
    expect(validateParams('listMemory', undefined).ok).toBe(true)
    expect(validateParams('listMemory', { limit: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns at most 20 items', () => {
    const result = (count: number) => ({ items: Array.from({ length: count }, (_, index) => ({ ...item, id: `note-${index}` })) })
    expect(Value.Check(METHODS.listMemory.result, result(0))).toBe(true)
    expect(Value.Check(METHODS.listMemory.result, result(20))).toBe(true)
    expect(Value.Check(METHODS.listMemory.result, result(21))).toBe(false)
    expect(Value.Check(METHODS.listMemory.result, { items: [{ ...item, extra: 1 }] })).toBe(false)
    expect(Value.Check(METHODS.listMemory.result, {})).toBe(false)
  })
})

describe('saveMemory', () => {
  it('takes a text, and an id when it edits', () => {
    expect(validateParams('saveMemory', { text: 'a note' })).toEqual({ ok: true, method: 'saveMemory', params: { text: 'a note' } })
    expect(validateParams('saveMemory', { id: 'note-1', text: 'a note' })).toMatchObject({ ok: true })
  })

  it('rejects extra properties, a missing text, an empty id and wrong types', () => {
    expect(validateParams('saveMemory', { text: 'a note', createdAt: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveMemory', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveMemory', { id: '', text: 'a note' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveMemory', { id: 'x'.repeat(129), text: 'a note' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveMemory', { text: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('leaves the 300 character rule to the engine but refuses an absurd payload', () => {
    expect(validateParams('saveMemory', { text: 'x'.repeat(MEMORY_MAX_CHARS + 1) }).ok).toBe(true)
    expect(validateParams('saveMemory', { text: 'x'.repeat(MEMORY_MAX_INPUT_CHARS) }).ok).toBe(true)
    expect(validateParams('saveMemory', { text: 'x'.repeat(MEMORY_MAX_INPUT_CHARS + 1) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('does not put the text into the problems of a bad request', () => {
    const marker = 'NOTE-MARKER-4e1c'
    const result = validateParams('saveMemory', { text: marker.repeat(MEMORY_MAX_INPUT_CHARS) })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('returns one item', () => {
    expect(Value.Check(METHODS.saveMemory.result, { item })).toBe(true)
    expect(Value.Check(METHODS.saveMemory.result, { item: { ...item, text: '' } })).toBe(false)
    expect(Value.Check(METHODS.saveMemory.result, {})).toBe(false)
  })
})

describe('deleteMemory', () => {
  it('takes an id and says whether a note was deleted', () => {
    expect(validateParams('deleteMemory', { id: 'note-1' })).toEqual({ ok: true, method: 'deleteMemory', params: { id: 'note-1' } })
    expect(validateParams('deleteMemory', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteMemory', { id: 'note-1', text: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(Value.Check(METHODS.deleteMemory.result, { deleted: true })).toBe(true)
    expect(Value.Check(METHODS.deleteMemory.result, { deleted: 'yes' })).toBe(false)
  })
})

describe('memory error codes', () => {
  it('are listed next to the planner codes', () => {
    for (const code of ['MEMORY_INVALID', 'MEMORY_FULL', 'MEMORY_DUPLICATE']) expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
