// @vitest-environment node
import { ERROR_CODES, RillError } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { memoryErrorKey, planErrorKey } from '../src/chat/model/errors'

const SERVER_CODES = [
  'LLM_UNAVAILABLE',
  'PLAN_INVALID',
  'PLAN_PROVIDER',
  'PLAN_CANCELLED',
  'PLAN_BUSY',
  'PLAN_EXISTS',
  'PLAN_NOT_CONFIRMED',
  'PLAN_DEPLOYED',
  'ATTACHMENT_REJECTED',
  'MEMORY_INVALID',
  'MEMORY_FULL',
  'MEMORY_DUPLICATE',
  'INVALID_PARAMS',
  'NOT_FOUND',
  'INTERNAL',
] as const

const MARKER = 'SERVER-TEXT-MARKER-4471'

describe('planErrorKey', () => {
  it('has its own key, present in both languages, for every code the plan, deploy and memory methods can return', () => {
    const keys = new Set<string>()
    for (const code of SERVER_CODES) {
      const key = planErrorKey(new RillError(code, MARKER))
      expect(key, code).not.toBe(planErrorKey(new Error('plain')))
      expect(ko, code).toHaveProperty([key])
      expect(en, code).toHaveProperty([key])
      keys.add(key)
    }
    expect(keys.size).toBe(SERVER_CODES.length)
  })

  it('also covers an invalid workflow at deploy time and a bad response', () => {
    for (const code of ['INVALID_WORKFLOW', 'BAD_RESPONSE']) {
      const key = planErrorKey(new RillError(code, MARKER))
      expect(key).not.toBe(planErrorKey(new Error('x')))
      expect(ko).toHaveProperty([key])
    }
  })

  it('maps an unknown code, a plain Error and a non-error to the generic key', () => {
    const generic = planErrorKey(new Error('boom'))
    expect(planErrorKey(new RillError('SOMETHING_NEW', 'x'))).toBe(generic)
    expect(planErrorKey('text')).toBe(generic)
    expect(planErrorKey(undefined)).toBe(generic)
    expect(planErrorKey(null)).toBe(generic)
    expect(planErrorKey({ code: 5 })).toBe(generic)
    expect(ko).toHaveProperty([generic])
    expect(en).toHaveProperty([generic])
  })

  it('never lets the text of the server, a problem or the error name reach the output', () => {
    for (const code of [...SERVER_CODES, 'SOMETHING_NEW']) {
      const error = new RillError(code, MARKER, [`${MARKER} problem`])
      for (const locale of ['ko', 'en'] as const) {
        expect(createTranslator(locale)(planErrorKey(error)), code).not.toContain(MARKER)
      }
    }
  })

  it('does not hand out a prototype key for a code like constructor', () => {
    const generic = planErrorKey(new Error('x'))
    expect(planErrorKey(new RillError('constructor', 'x'))).toBe(generic)
    expect(planErrorKey(new RillError('__proto__', 'x'))).toBe(generic)
    expect(planErrorKey(new RillError('toString', 'x'))).toBe(generic)
  })

  it('covers every code of the protocol that is not one of the explainer or recipe codes by a key or the generic one', () => {
    for (const code of ERROR_CODES) {
      const key = planErrorKey(new RillError(code, 'x'))
      expect(ko).toHaveProperty([key])
    }
  })
})

describe('memoryErrorKey', () => {
  it('reads the rule of an invalid note from the problems and never shows their text', () => {
    const rules = ['empty', 'control_character', 'line_separator', 'bidi_format', 'format_character', 'too_long']
    const keys = new Set<string>()
    for (const rule of rules) {
      const key = memoryErrorKey(new RillError('MEMORY_INVALID', MARKER, [`${rule}: ${MARKER}`]))
      expect(ko).toHaveProperty([key])
      expect(en).toHaveProperty([key])
      expect(createTranslator('en')(key)).not.toContain(MARKER)
      keys.add(key)
    }
    expect(keys.size).toBe(rules.length)
  })

  it('falls back to the general invalid-note message for a rule it does not know and to the plan keys for other codes', () => {
    const general = memoryErrorKey(new RillError('MEMORY_INVALID', 'x', []))
    expect(memoryErrorKey(new RillError('MEMORY_INVALID', 'x', ['new_rule: text']))).toBe(general)
    for (const rule of ['constructor', '__proto__', 'toString']) expect(memoryErrorKey(new RillError('MEMORY_INVALID', 'x', [`${rule}: text`]))).toBe(general)
    expect(memoryErrorKey(new RillError('MEMORY_FULL', 'x'))).toBe(planErrorKey(new RillError('MEMORY_FULL', 'x')))
    expect(memoryErrorKey(new Error('x'))).toBe(planErrorKey(new Error('x')))
  })
})
