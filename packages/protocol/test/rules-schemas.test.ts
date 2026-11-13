import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  PLAN_EFFORTS,
  PlanEffortSchema,
  RULE_KINDS,
  RULE_MAX_INPUT_CHARS,
  RULE_MAX_ITEMS,
  METHODS,
  PlanMetaSchema,
  RuleSchema,
  validateParams,
} from '../src/index'

const issue = { stage: 3, pointer: '/nodes/1/config/url', code: 'rule_violation', message: 'node n1: the host is not allowed', hint: 'allowed hosts: a.com' }
const rule = { id: '3f2b8c1e-6a4d-4f5b-9c0e-1a2b3c4d5e6f', kind: 'allowHost', value: 'api.example.com', createdAt: 1000 }

describe('rule constants', () => {
  it('has three kinds and a limit of 30 rules', () => {
    expect([...RULE_KINDS]).toEqual(['forbidNode', 'allowHost', 'maxPlanEffort'])
    expect(RULE_MAX_ITEMS).toBe(30)
    expect(RULE_MAX_INPUT_CHARS).toBeGreaterThanOrEqual(253)
  })

  it('names the planning efforts from the lowest to the highest, as the effort schema does', () => {
    expect([...PLAN_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const effort of PLAN_EFFORTS) expect(Value.Check(PlanEffortSchema, effort)).toBe(true)
    expect(Value.Check(PlanEffortSchema, 'ultra')).toBe(false)
  })
})

describe('RuleSchema', () => {
  const valid = (value: unknown) => Value.Check(RuleSchema, value)

  it('accepts each kind', () => {
    for (const kind of RULE_KINDS) expect(valid({ ...rule, kind })).toBe(true)
  })

  it('rejects an unknown kind, extra properties, missing fields and wrong types', () => {
    expect(valid({ ...rule, kind: 'allowFolder' })).toBe(false)
    expect(valid({ ...rule, extra: 1 })).toBe(false)
    for (const key of ['id', 'kind', 'value', 'createdAt'] as const) {
      const rest: Record<string, unknown> = { ...rule }
      delete rest[key]
      expect(valid(rest), key).toBe(false)
    }
    expect(valid({ ...rule, id: '' })).toBe(false)
    expect(valid({ ...rule, value: '' })).toBe(false)
    expect(valid({ ...rule, value: 5 })).toBe(false)
    expect(valid({ ...rule, createdAt: '1' })).toBe(false)
  })
})

describe('listRules', () => {
  it('takes no params', () => {
    expect(validateParams('listRules', {})).toEqual({ ok: true, method: 'listRules', params: {} })
    expect(validateParams('listRules', { limit: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns at most 30 rules', () => {
    const result = (count: number) => ({ rules: Array.from({ length: count }, (_, index) => ({ ...rule, id: `rule-${index}` })) })
    expect(Value.Check(METHODS.listRules.result, result(0))).toBe(true)
    expect(Value.Check(METHODS.listRules.result, result(30))).toBe(true)
    expect(Value.Check(METHODS.listRules.result, result(31))).toBe(false)
    expect(Value.Check(METHODS.listRules.result, { rules: [{ ...rule, extra: 1 }] })).toBe(false)
  })
})

describe('saveRule', () => {
  it('takes a kind and a value and nothing else', () => {
    expect(validateParams('saveRule', { kind: 'allowHost', value: 'api.example.com' })).toEqual({
      ok: true,
      method: 'saveRule',
      params: { kind: 'allowHost', value: 'api.example.com' },
    })
    expect(validateParams('saveRule', { kind: 'allowHost', value: 'a.com', id: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveRule', { kind: 'nope', value: 'a.com' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveRule', { value: 'a.com' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveRule', { kind: 'allowHost' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveRule', { kind: 'allowHost', value: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('leaves the value grammar to the engine but refuses an absurd payload', () => {
    expect(validateParams('saveRule', { kind: 'allowHost', value: 'x'.repeat(RULE_MAX_INPUT_CHARS) }).ok).toBe(true)
    expect(validateParams('saveRule', { kind: 'allowHost', value: 'x'.repeat(RULE_MAX_INPUT_CHARS + 1) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('does not put the value into the problems of a bad request', () => {
    const marker = 'RULE-MARKER-9d3a'
    const result = validateParams('saveRule', { kind: 'allowHost', value: marker.repeat(RULE_MAX_INPUT_CHARS) })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('returns one rule', () => {
    expect(Value.Check(METHODS.saveRule.result, { rule })).toBe(true)
    expect(Value.Check(METHODS.saveRule.result, { rule: { ...rule, value: '' } })).toBe(false)
    expect(Value.Check(METHODS.saveRule.result, {})).toBe(false)
  })
})

describe('deleteRule', () => {
  it('takes an id and says whether a rule was deleted', () => {
    expect(validateParams('deleteRule', { id: 'rule-1' })).toEqual({ ok: true, method: 'deleteRule', params: { id: 'rule-1' } })
    expect(validateParams('deleteRule', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteRule', { id: 'rule-1', kind: 'allowHost' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(Value.Check(METHODS.deleteRule.result, { deleted: true })).toBe(true)
    expect(Value.Check(METHODS.deleteRule.result, { deleted: 'yes' })).toBe(false)
  })
})

describe('checkRules', () => {
  it('takes no params', () => {
    expect(validateParams('checkRules', {})).toEqual({ ok: true, method: 'checkRules', params: {} })
    expect(validateParams('checkRules', { workflowId: 'w' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns workflows with at most 20 issues each and at most 200 workflows', () => {
    const entry = (issues: unknown[]) => ({ workflowId: 'w1', name: 'wf', issues })
    expect(Value.Check(METHODS.checkRules.result, { violations: [] })).toBe(true)
    expect(Value.Check(METHODS.checkRules.result, { violations: [entry([issue])] })).toBe(true)
    expect(Value.Check(METHODS.checkRules.result, { violations: [entry(Array.from({ length: 20 }, () => issue))] })).toBe(true)
    expect(Value.Check(METHODS.checkRules.result, { violations: [entry(Array.from({ length: 21 }, () => issue))] })).toBe(false)
    expect(Value.Check(METHODS.checkRules.result, { violations: Array.from({ length: 200 }, () => entry([issue])) })).toBe(true)
    expect(Value.Check(METHODS.checkRules.result, { violations: Array.from({ length: 201 }, () => entry([issue])) })).toBe(false)
    expect(Value.Check(METHODS.checkRules.result, { violations: [{ ...entry([issue]), extra: 1 }] })).toBe(false)
    expect(Value.Check(METHODS.checkRules.result, { violations: [entry([{ ...issue, stage: 9 }])] })).toBe(false)
  })
})

describe('rule error codes', () => {
  it('are listed once next to the memory codes', () => {
    for (const code of ['RULE_INVALID', 'RULE_FULL', 'RULE_DUPLICATE', 'RULE_NOT_FOUND', 'RULE_VIOLATION']) expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

describe('the effort meta of a plan', () => {
  const rounds: unknown[] = []
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  const meta = (detail: unknown) => ({ rounds, usage, costUsd: null, model: 'm', effort: 'high', fallbackUsed: false, effortDetail: detail })
  const detail = { requested: 'xhigh', effective: 'high', native: 'high', collapsed: true, cappedByRule: true }

  it('says whether a rule capped the effort', () => {
    expect(Value.Check(PlanMetaSchema, meta(detail))).toBe(true)
    expect(Value.Check(PlanMetaSchema, meta({ ...detail, cappedByRule: false }))).toBe(true)
    expect(Value.Check(PlanMetaSchema, meta({ ...detail, cappedByRule: 'yes' }))).toBe(false)
  })

  it('requires the flag when there is an effort detail', () => {
    const without: Record<string, unknown> = { ...detail }
    delete without.cappedByRule
    expect(Value.Check(PlanMetaSchema, meta(without))).toBe(false)
  })
})
