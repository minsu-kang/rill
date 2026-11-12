import { describe, expect, it } from 'vitest'
import { createTranslator, type MessageKey } from '../src/i18n'
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

  it('have no empty or whitespace-only values', () => {
    for (const dictionary of [ko, en]) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), key).not.toBe('')
      }
    }
  })

  it('use the same placeholders in both languages and no stray braces', () => {
    for (const key of Object.keys(ko) as MessageKey[]) {
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
