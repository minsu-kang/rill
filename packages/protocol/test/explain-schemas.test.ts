import type { ExplainResult as PlannerExplainResult } from '../../planner/src/index'
import { FAILURE_SIGNALS, LIKELY_CAUSES, SUGGESTED_ACTIONS } from '../../planner/src/index'
import type Type from 'typebox'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  EXPLAIN_LIKELY_CAUSES,
  EXPLAIN_SIGNALS,
  EXPLAIN_SUGGESTED_ACTIONS,
  ExplainMetaSchema,
  ExplainResultSchema,
  METHODS,
  validateParams,
} from '../src/index'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const meta = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  effort: { requested: 'low', effective: 'low', native: 'low', collapsed: false },
  digestChars: 1800,
  truncated: false,
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: 0.004,
  repaired: false,
}

const result = {
  runId: 'run-1',
  explanation: 'The orders service rejected the credentials of node n1.',
  likelyCause: 'credentials_or_connection',
  suggestedActions: ['open_connections'],
  signals: [{ nodeId: 'n1', signal: 'http_status_401_403' }],
  meta,
}

const valid = (value: unknown): boolean => Value.Check(ExplainResultSchema, value)

describe('the lists', () => {
  it('are the lists of the planner', () => {
    expect([...EXPLAIN_LIKELY_CAUSES]).toEqual([...LIKELY_CAUSES])
    expect([...EXPLAIN_SUGGESTED_ACTIONS]).toEqual([...SUGGESTED_ACTIONS])
    expect([...EXPLAIN_SIGNALS]).toEqual([...FAILURE_SIGNALS])
  })

  it('stay mutually assignable with the planner result type', () => {
    const checks: [MutuallyAssignable<Omit<Type.Static<typeof ExplainResultSchema>, 'runId'>, PlannerExplainResult>] = [true]
    expect(checks).toEqual([true])
  })
})

describe('explainRun parameters', () => {
  it('take a run id and an optional effort of low, medium or high', () => {
    expect(validateParams('explainRun', { runId: 'run-1' })).toEqual({ ok: true, method: 'explainRun', params: { runId: 'run-1' } })
    for (const effort of ['low', 'medium', 'high']) expect(validateParams('explainRun', { runId: 'run-1', effort }).ok).toBe(true)
  })

  it('refuse xhigh, max and any other effort', () => {
    for (const effort of ['xhigh', 'max', 'LOW', '', 3, null]) expect(validateParams('explainRun', { runId: 'run-1', effort })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('refuse a missing or empty run id, a run id that is not text, and extra keys', () => {
    expect(validateParams('explainRun', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', undefined)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: 'x'.repeat(129) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: 7 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: 'run-1', useMemory: true })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: 'run-1', text: 'why' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })
})

describe('the explainRun result', () => {
  it('is the schema of the method', () => {
    expect(METHODS.explainRun.result).toBe(ExplainResultSchema)
    expect(valid(result)).toBe(true)
  })

  it('takes a fix proposal, no signals, no actions and a null cost', () => {
    expect(valid({ ...result, fixProposal: { nodeId: 'n1', requestText: 'Use the connection billing for this call' } })).toBe(true)
    expect(valid({ ...result, signals: [], suggestedActions: [] })).toBe(true)
    expect(valid({ ...result, meta: { ...meta, costUsd: null } })).toBe(true)
  })

  it('is closed: an extra key anywhere is refused', () => {
    expect(valid({ ...result, extra: 1 })).toBe(false)
    expect(valid({ ...result, fixProposal: { nodeId: 'n1', requestText: 'x', extra: 1 } })).toBe(false)
    expect(valid({ ...result, signals: [{ nodeId: 'n1', signal: 'unknown', text: 'x' }] })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, extra: 1 } })).toBe(false)
  })

  it('limits the text, the actions and the words', () => {
    expect(valid({ ...result, explanation: '' })).toBe(false)
    expect(valid({ ...result, explanation: 'x'.repeat(1500) })).toBe(true)
    expect(valid({ ...result, explanation: 'x'.repeat(1501) })).toBe(false)
    expect(valid({ ...result, fixProposal: { nodeId: 'n1', requestText: 'x'.repeat(400) } })).toBe(true)
    expect(valid({ ...result, fixProposal: { nodeId: 'n1', requestText: 'x'.repeat(401) } })).toBe(false)
    expect(valid({ ...result, suggestedActions: ['retry_run', 'edit_node', 'none'] })).toBe(true)
    expect(valid({ ...result, suggestedActions: ['retry_run', 'edit_node', 'none', 'wait_and_retry'] })).toBe(false)
    expect(valid({ ...result, likelyCause: 'bad_luck' })).toBe(false)
    expect(valid({ ...result, suggestedActions: ['reboot'] })).toBe(false)
    expect(valid({ ...result, signals: [{ nodeId: 'n1', signal: 'bad_signal' }] })).toBe(false)
  })

  it('names the provider that got the data and how much was sent', () => {
    expect(valid({ ...result, meta: { ...meta, provider: undefined } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, digestChars: -1 } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, digestChars: 1.5 } })).toBe(false)
    expect(Value.Check(ExplainMetaSchema, meta)).toBe(true)
  })
})

describe('explain error codes', () => {
  it('are in the list next to the others, once', () => {
    for (const code of ['RUN_NOT_EXPLAINABLE', 'EXPLAIN_BUSY', 'EXPLAIN_PROVIDER', 'EXPLAIN_INVALID']) expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
