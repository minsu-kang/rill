import type { ReviewResult as PlannerReviewResult } from '../../planner/src/index'
import { REVIEW_SEVERITIES as PLANNER_SEVERITIES } from '../../planner/src/index'
import type Type from 'typebox'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  METHODS,
  REVIEW_FINDING_MAX_CHARS,
  REVIEW_MAX_FINDINGS,
  REVIEW_SEVERITIES,
  REVIEW_SUMMARY_MAX_CHARS,
  ReviewFindingSchema,
  ReviewMetaSchema,
  ReviewResultSchema,
  ReviewSchema,
  validateParams,
} from '../src/index'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const meta = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  effort: { requested: 'medium', effective: 'medium', native: 'medium', collapsed: false },
  usage: { inputTokens: 3000, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: 0.01,
  repaired: false,
  agentUsed: { id: 'agent-1', name: 'Careful reviewer' },
  skillsUsed: 2,
  agentDropped: 0,
}

const review = {
  summary: 'The workflow does what the request says, but it posts to a channel nobody asked for.',
  findings: [
    { severity: 'problem', text: 'Node n2 posts to a Slack channel that the request does not name.', nodeId: 'n2' },
    { severity: 'info', text: 'The schedule runs at 09:00 in the local time zone.' },
  ],
}

const result = { review, meta }

const valid = (value: unknown): boolean => Value.Check(ReviewResultSchema, value)

describe('the lists and the limits', () => {
  it('know three severities, and the planner knows the same three', () => {
    expect([...REVIEW_SEVERITIES].sort()).toEqual(['info', 'problem', 'warning'])
    expect([...PLANNER_SEVERITIES]).toEqual([...REVIEW_SEVERITIES])
  })

  it('are 400 characters for the summary and for a finding, and 10 findings', () => {
    expect(REVIEW_SUMMARY_MAX_CHARS).toBe(400)
    expect(REVIEW_FINDING_MAX_CHARS).toBe(400)
    expect(REVIEW_MAX_FINDINGS).toBe(10)
  })

  it('stay mutually assignable with the planner result type', () => {
    const checks: [MutuallyAssignable<Type.Static<typeof ReviewResultSchema>, PlannerReviewResult>] = [true]
    expect(checks).toEqual([true])
  })
})

describe('reviewPlan parameters', () => {
  const params = { planId: 'plan-1', agentId: 'agent-1' }

  it('take a plan id, an agent id and an optional effort of low, medium or high', () => {
    expect(validateParams('reviewPlan', params)).toEqual({ ok: true, method: 'reviewPlan', params })
    for (const effort of ['low', 'medium', 'high']) expect(validateParams('reviewPlan', { ...params, effort }).ok).toBe(true)
  })

  it('refuse xhigh, max and any other effort', () => {
    for (const effort of ['xhigh', 'max', 'LOW', '', 3, null]) expect(validateParams('reviewPlan', { ...params, effort })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('need both ids, as text of 1 to 128 characters', () => {
    expect(validateParams('reviewPlan', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('reviewPlan', undefined)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('reviewPlan', { planId: 'plan-1' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('reviewPlan', { agentId: 'agent-1' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    for (const key of ['planId', 'agentId']) {
      for (const bad of ['', 'x'.repeat(129), 7, null]) expect(validateParams('reviewPlan', { ...params, [key]: bad }), `${key} ${String(bad).length}`).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
  })

  it('refuse extra keys, so a client cannot send a plan, a workflow, text or a profile of its own', () => {
    for (const extra of [{ workflow: {} }, { text: 'review this' }, { requestText: 'x' }, { persona: 'x' }, { instructions: 'x' }, { agent: { persona: 'x' } }, { useMemory: true }, { attachments: [] }]) {
      expect(validateParams('reviewPlan', { ...params, ...extra }), JSON.stringify(extra)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
  })
})

describe('the reviewPlan result', () => {
  it('is the schema of the method, and carries a review and a meta', () => {
    expect(METHODS.reviewPlan.result).toBe(ReviewResultSchema)
    expect(valid(result)).toBe(true)
    expect(Value.Check(ReviewSchema, review)).toBe(true)
    expect(Value.Check(ReviewMetaSchema, meta)).toBe(true)
  })

  it('takes no findings, a finding without a node and a null cost', () => {
    expect(valid({ review: { summary: 'Looks right.', findings: [] }, meta })).toBe(true)
    expect(valid({ review, meta: { ...meta, costUsd: null } })).toBe(true)
    expect(valid({ review, meta: { ...meta, costNote: 'The cost can be above the estimate.' } })).toBe(true)
  })

  it('is closed: an extra key anywhere is refused', () => {
    expect(valid({ ...result, extra: 1 })).toBe(false)
    expect(valid({ ...result, review: { ...review, extra: 1 } })).toBe(false)
    expect(valid({ ...result, review: { ...review, findings: [{ severity: 'info', text: 'x', extra: 1 }] } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, extra: 1 } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, agentUsed: { ...meta.agentUsed, persona: 'x' } } })).toBe(false)
    expect(valid({ review })).toBe(false)
    expect(valid({ meta })).toBe(false)
  })

  it('limits the texts, the number of findings and the severity', () => {
    expect(valid({ ...result, review: { ...review, summary: '' } })).toBe(false)
    expect(valid({ ...result, review: { ...review, summary: 'x'.repeat(400) } })).toBe(true)
    expect(valid({ ...result, review: { ...review, summary: 'x'.repeat(401) } })).toBe(false)
    expect(valid({ ...result, review: { ...review, summary: '😀'.repeat(400) } })).toBe(true)
    expect(valid({ ...result, review: { ...review, summary: '😀'.repeat(401) } })).toBe(false)
    const finding = (text: string) => ({ severity: 'warning', text })
    expect(valid({ ...result, review: { ...review, findings: [finding('')] } })).toBe(false)
    expect(valid({ ...result, review: { ...review, findings: [finding('x'.repeat(400))] } })).toBe(true)
    expect(valid({ ...result, review: { ...review, findings: [finding('x'.repeat(401))] } })).toBe(false)
    expect(valid({ ...result, review: { ...review, findings: Array.from({ length: 10 }, () => finding('x')) } })).toBe(true)
    expect(valid({ ...result, review: { ...review, findings: Array.from({ length: 11 }, () => finding('x')) } })).toBe(false)
    for (const severity of ['error', 'PROBLEM', '', 1, null]) expect(Value.Check(ReviewFindingSchema, { severity, text: 'x' }), String(severity)).toBe(false)
    for (const severity of ['info', 'warning', 'problem']) expect(Value.Check(ReviewFindingSchema, { severity, text: 'x' }), severity).toBe(true)
  })

  it('limits the node id like every other id', () => {
    for (const nodeId of ['', 'x'.repeat(129), 5, null]) expect(Value.Check(ReviewFindingSchema, { severity: 'info', text: 'x', nodeId }), `${String(nodeId).length}`).toBe(false)
    expect(Value.Check(ReviewFindingSchema, { severity: 'info', text: 'x', nodeId: 'n1' })).toBe(true)
  })

  it('names the reviewer that got the data, and how many skills and whether its text was left out', () => {
    expect(valid({ ...result, meta: { ...meta, provider: undefined } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, agentUsed: undefined } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, agentUsed: { id: '', name: 'x' } } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, agentUsed: { id: 'a', name: '' } } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, agentUsed: { id: 'a', name: 'x'.repeat(61) } } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, skillsUsed: -1 } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, skillsUsed: 1.5 } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, skillsUsed: 0, agentDropped: 1 } })).toBe(true)
    expect(valid({ ...result, meta: { ...meta, agentDropped: -1 } })).toBe(false)
    expect(valid({ ...result, meta: { ...meta, repaired: 'no' } })).toBe(false)
  })
})

describe('review error codes', () => {
  it('are in the list next to the others, once', () => {
    for (const code of ['AGENT_NOT_REVIEWER', 'PLAN_NOT_REVIEWABLE', 'REVIEW_BUSY', 'REVIEW_PROVIDER', 'REVIEW_INVALID']) expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
