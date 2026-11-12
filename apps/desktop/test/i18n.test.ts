import { describe, expect, it } from 'vitest'
import { createTranslator, type DictionaryKey, type MessageKey } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'

const PLACEHOLDER = /\{([^{}]*)\}/g

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort()
}

describe('createTranslator', () => {
  it('returns the Korean text by default key and the English text for en', () => {
    expect(createTranslator('ko')('status.running')).toBe(ko['status.running'])
    expect(createTranslator('en')('status.running')).toBe(en['status.running'])
    expect(ko['status.running']).not.toBe(en['status.running'])
  })

  it('fills {name} placeholders with strings and numbers', () => {
    const t = createTranslator('en')
    expect(t('node.attempt', { count: 3 })).toBe(en['node.attempt'].replace('{count}', '3'))
    expect(t('workspace.loadError', { message: 'boom' })).toContain('boom')
  })

  it('fills every occurrence and leaves values that look like placeholders alone', () => {
    const t = createTranslator('en')
    const text = t('workspace.loadError', { message: '{count} $& $1' })
    expect(text).toContain('{count} $& $1')
  })

  it('leaves an unfilled placeholder visible and ignores inherited names', () => {
    const t = createTranslator('en')
    expect(t('node.attempt')).toBe(en['node.attempt'])
    expect(t('node.attempt', {})).toBe(en['node.attempt'])
    expect(t('node.attempt', { constructor: 'x' } as Record<string, string>)).toBe(en['node.attempt'])
  })

  it('picks the singular form for one and the plural form for every other count in English', () => {
    const t = createTranslator('en')
    expect(t('inspector.retryValue', { count: 1 })).toBe('Up to 1 attempt')
    expect(t('inspector.retryValue', { count: 2 })).toBe('Up to 2 attempts')
    expect(t('inspector.retryValue', { count: 0 })).toBe('Up to 0 attempts')
    expect(t('json.moreCharacters', { count: 1 })).toBe('… 1 more character')
    expect(t('json.moreCharacters', { count: 5 })).toBe('… 5 more characters')
  })

  it('uses one text for every count in Korean', () => {
    const t = createTranslator('ko')
    expect(t('inspector.retryValue', { count: 1 })).toBe('최대 1번 시도해요')
    expect(t('inspector.retryValue', { count: 3 })).toBe('최대 3번 시도해요')
    expect(t('json.moreCharacters', { count: 1 })).toBe('… 1자 더 있음')
  })

  it('groups the digits of a number with the separator of the language and leaves a string alone', () => {
    expect(createTranslator('en')('json.moreCharacters', { count: 9975 })).toBe('… 9,975 more characters')
    expect(createTranslator('ko')('json.moreCharacters', { count: 1234567 })).toBe('… 1,234,567자 더 있음')
    expect(createTranslator('en')('json.moreCharacters', { count: '9975' })).toBe('… 9975 more characters')
    expect(createTranslator('en')('node.attempt', { count: 12 })).toBe('Attempt 12')
  })

  it('uses the plain key when the count is not a number or the key has no plural forms', () => {
    const t = createTranslator('en')
    expect(t('json.more', { count: 1 })).toBe('1 more')
    expect(t('inspector.retryValue', { count: '1' })).toBe('Up to 1 attempts')
    expect(t('inspector.retryValue', {})).toBe('Up to {count} attempts')
  })

  it('returns the key itself for a key that is missing', () => {
    expect(createTranslator('ko')('no.such.key' as MessageKey)).toBe('no.such.key')
    expect(createTranslator('en')('constructor' as MessageKey)).toBe('constructor')
    expect(createTranslator('en')('__proto__' as MessageKey)).toBe('__proto__')
  })
})

describe('dictionaries', () => {
  it('have exactly the same keys in Korean and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort())
  })

  it('give every plural message a one and an other form in both languages and never also a plain key', () => {
    const keys = Object.keys(ko)
    const plural = keys.filter((key) => /\.(one|other)$/.test(key)).map((key) => key.replace(/\.(one|other)$/, ''))
    expect(plural.length).toBeGreaterThanOrEqual(2)
    for (const base of new Set(plural)) {
      for (const dictionary of [ko, en] as Array<Record<string, string>>) {
        expect(dictionary, base).toHaveProperty([`${base}.one`])
        expect(dictionary, base).toHaveProperty([`${base}.other`])
        expect(dictionary, base).not.toHaveProperty([base])
      }
    }
  })

  it('have no empty or whitespace-only values', () => {
    for (const dictionary of [ko, en]) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), key).not.toBe('')
      }
    }
  })

  it('use the same placeholders in both languages and no stray braces', () => {
    for (const key of Object.keys(ko) as DictionaryKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(ko[key]))
      for (const value of [ko[key], en[key]]) {
        for (const name of placeholders(value)) expect(name, key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
        expect(value.replace(PLACEHOLDER, ''), key).not.toMatch(/[{}]/)
      }
    }
  })

  it('cover every node and run status the later screens show', () => {
    for (const status of ['idle', 'running', 'succeeded', 'failed', 'abandoned', 'skipped', 'continued']) {
      expect(ko).toHaveProperty(`status.${status}`)
    }
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
      expect(ko).toHaveProperty(`run.status.${status}`)
    }
  })
})

describe('createTranslator with several placeholders', () => {
  it('fills each of them', () => {
    expect(createTranslator('en')('graph.edgeLabelWhen', { from: 'a', to: 'b', when: 'c' })).toBe('Connection from a to b, when c')
    expect(createTranslator('ko')('graph.edgeLabelWhen', { from: 'a', to: 'b', when: 'c' })).toBe('a에서 b까지 연결, 조건 c')
  })
})
