// @vitest-environment node
import { EXPLAIN_LIKELY_CAUSES, EXPLAIN_SIGNALS, EXPLAIN_SUGGESTED_ACTIONS } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { actionKey, causeKey, isStateChanging, signalKey } from '../src/explain/model/labels'

describe('explain labels', () => {
  it('give every likely cause, action and signal of the protocol its own key in both languages', () => {
    const keys = [...EXPLAIN_LIKELY_CAUSES.map(causeKey), ...EXPLAIN_SUGGESTED_ACTIONS.map(actionKey), ...EXPLAIN_SIGNALS.map(signalKey)]
    expect(keys).toHaveLength(8 + 7 + 19)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(ko, key).toHaveProperty(key)
      expect(en, key).toHaveProperty(key)
      expect(createTranslator('ko')(key).trim(), key).not.toBe('')
    }
  })

  it('have no explain message in the dictionaries that nothing uses', () => {
    const known = new Set<string>([...EXPLAIN_LIKELY_CAUSES.map(causeKey), ...EXPLAIN_SUGGESTED_ACTIONS.map(actionKey), ...EXPLAIN_SIGNALS.map(signalKey)])
    const strays = Object.keys(ko).filter((key) => /^explain\.(cause|action|signal)\./.test(key) && !known.has(key))
    expect(strays).toEqual([])
  })

  it('treat only a retry and turning the workflow off as state changing', () => {
    const changing = EXPLAIN_SUGGESTED_ACTIONS.filter(isStateChanging)
    expect(changing).toEqual(['retry_run', 'deactivate_workflow'])
  })
})
