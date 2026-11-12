// @vitest-environment node
import { RillError, type ExplainResult } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { canExplain, explainErrorKey, explainReducer, IDLE_EXPLAIN, type ExplainState } from '../src/explain/model/explain-state'
import { explainCases } from '../src/fixtures/explain'
import { createTranslator } from '../src/i18n'
import { ko } from '../src/i18n/ko'

const RESULT: ExplainResult = explainCases.configuration

describe('explainReducer', () => {
  it('opens the notice from idle, done and error and keeps the chosen effort', () => {
    expect(explainReducer(IDLE_EXPLAIN, { type: 'open', effort: 'low' })).toEqual({ phase: 'confirming', effort: 'low' })
    expect(explainReducer({ phase: 'done', result: RESULT }, { type: 'open', effort: 'high' })).toEqual({ phase: 'confirming', effort: 'high' })
    expect(explainReducer({ phase: 'error', key: 'explain.error.generic' }, { type: 'open', effort: 'medium' })).toEqual({ phase: 'confirming', effort: 'medium' })
  })

  it('does not open the notice while a request is running', () => {
    const asking: ExplainState = { phase: 'asking', effort: 'medium', requestId: 1 }
    expect(explainReducer(asking, { type: 'open', effort: 'low' })).toBe(asking)
  })

  it('cancels only a notice', () => {
    expect(explainReducer({ phase: 'confirming', effort: 'medium' }, { type: 'cancel' })).toEqual(IDLE_EXPLAIN)
    const asking: ExplainState = { phase: 'asking', effort: 'medium', requestId: 1 }
    expect(explainReducer(asking, { type: 'cancel' })).toBe(asking)
    const done: ExplainState = { phase: 'done', result: RESULT }
    expect(explainReducer(done, { type: 'cancel' })).toBe(done)
  })

  it('starts a request from idle, from the notice, after an answer and after an error, but not twice', () => {
    const starts: ExplainState[] = [IDLE_EXPLAIN, { phase: 'confirming', effort: 'low' }, { phase: 'done', result: RESULT }, { phase: 'error', key: 'explain.error.busy' }]
    for (const from of starts) {
      expect(explainReducer(from, { type: 'send', effort: 'high', requestId: 7 })).toEqual({ phase: 'asking', effort: 'high', requestId: 7 })
    }
    const asking: ExplainState = { phase: 'asking', effort: 'low', requestId: 3 }
    expect(explainReducer(asking, { type: 'send', effort: 'high', requestId: 4 })).toBe(asking)
  })

  it('takes the result and the error of the request that is running', () => {
    const asking: ExplainState = { phase: 'asking', effort: 'medium', requestId: 5 }
    expect(explainReducer(asking, { type: 'succeeded', requestId: 5, result: RESULT })).toEqual({ phase: 'done', result: RESULT })
    expect(explainReducer(asking, { type: 'failed', requestId: 5, key: 'explain.error.busy' })).toEqual({ phase: 'error', key: 'explain.error.busy' })
  })

  it('drops a late result or error of an earlier request', () => {
    const asking: ExplainState = { phase: 'asking', effort: 'medium', requestId: 6 }
    expect(explainReducer(asking, { type: 'succeeded', requestId: 5, result: RESULT })).toBe(asking)
    expect(explainReducer(asking, { type: 'failed', requestId: 5, key: 'explain.error.busy' })).toBe(asking)
    expect(explainReducer(IDLE_EXPLAIN, { type: 'succeeded', requestId: 6, result: RESULT })).toBe(IDLE_EXPLAIN)
    const done: ExplainState = { phase: 'done', result: RESULT }
    expect(explainReducer(done, { type: 'failed', requestId: 6, key: 'explain.error.generic' })).toBe(done)
  })

  it('resets from every state, also while asking', () => {
    const states: ExplainState[] = [IDLE_EXPLAIN, { phase: 'confirming', effort: 'low' }, { phase: 'asking', effort: 'low', requestId: 1 }, { phase: 'done', result: RESULT }, { phase: 'error', key: 'explain.error.generic' }]
    for (const from of states) expect(explainReducer(from, { type: 'reset' })).toEqual(IDLE_EXPLAIN)
  })
})

describe('explainErrorKey', () => {
  const CODES: Record<string, string> = {
    NOT_FOUND: 'explain.error.notFound',
    RUN_NOT_EXPLAINABLE: 'explain.error.notExplainable',
    LLM_UNAVAILABLE: 'explain.error.llmUnavailable',
    EXPLAIN_BUSY: 'explain.error.busy',
    EXPLAIN_PROVIDER: 'explain.error.provider',
    EXPLAIN_INVALID: 'explain.error.invalid',
    INVALID_PARAMS: 'explain.error.params',
  }

  it('maps every code of explainRun to its own existing message', () => {
    for (const [code, key] of Object.entries(CODES)) {
      const found = explainErrorKey(new RillError(code, 'server text'))
      expect(found).toBe(key)
      expect(ko).toHaveProperty(found)
    }
    expect(new Set(Object.values(CODES)).size).toBe(Object.keys(CODES).length)
  })

  it('uses the generic message for any other code and for things that are not errors', () => {
    for (const value of [new RillError('INTERNAL', 'x'), new Error('plain'), 'text', null, undefined, 42, { code: 7 }, { code: 'constructor' }, { code: '__proto__' }]) {
      expect(explainErrorKey(value)).toBe('explain.error.generic')
    }
  })

  it('never carries the server text', () => {
    const MARKER = 'SERVER-TEXT-MARKER-77'
    for (const code of [...Object.keys(CODES), 'INTERNAL']) {
      const key = explainErrorKey(new RillError(code, MARKER, [MARKER]))
      expect(key).not.toContain(MARKER)
      expect(createTranslator('ko')(key)).not.toContain(MARKER)
    }
  })
})

describe('canExplain', () => {
  it('allows only a failed run', () => {
    expect(canExplain({ status: 'failed' })).toBe(true)
    for (const status of ['queued', 'running', 'succeeded', 'cancelled'] as const) expect(canExplain({ status }), status).toBe(false)
    expect(canExplain(undefined)).toBe(false)
  })
})
