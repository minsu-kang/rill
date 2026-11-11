import type {
  AttachmentRef as PlannerAttachmentRef,
  Flag as PlannerFlag,
  PatchOp as PlannerPatchOp,
  PlanEffort as PlannerPlanEffort,
  PlanQuestion as PlannerPlanQuestion,
  PlanResult as PlannerPlanResult,
  PlanResultBody as PlannerPlanResultBody,
  PlanTurn as PlannerPlanTurn,
} from '../../planner/src/index'
import Type from 'typebox'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  AttachmentRefSchema,
  ERROR_CODES,
  FlagSchema,
  METHODS,
  PatchOpSchema,
  PlanEffortSchema,
  PlanMetaSchema,
  PlanQuestionSchema,
  PlanRecordSchema,
  PlanResultBodySchema,
  PlanSummarySchema,
  PlanTurnSchema,
  flagKey,
  validateParams,
} from '../src/index'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('schemas against the planner types', () => {
  it('reports a difference between two different types', () => {
    // @ts-expect-error the helper must say false for types that differ
    const different: MutuallyAssignable<{ a: 1 }, { a: 2 }> = true
    expect(different).toBe(true)
  })

  it('stays mutually assignable with the planner types', () => {
    const checks: [
      MutuallyAssignable<Type.Static<typeof PlanResultBodySchema>, PlannerPlanResultBody>,
      MutuallyAssignable<Type.Static<typeof FlagSchema>, PlannerFlag>,
      MutuallyAssignable<Type.Static<typeof AttachmentRefSchema>, PlannerAttachmentRef>,
      MutuallyAssignable<Type.Static<typeof PlanQuestionSchema>, PlannerPlanQuestion>,
      MutuallyAssignable<Type.Static<typeof PatchOpSchema>, PlannerPatchOp>,
      MutuallyAssignable<Type.Static<typeof PlanTurnSchema>, PlannerPlanTurn>,
      MutuallyAssignable<Type.Static<typeof PlanEffortSchema>, PlannerPlanEffort>,
      MutuallyAssignable<
        Type.Static<typeof PlanMetaSchema>,
        Pick<PlannerPlanResult, 'rounds' | 'usage' | 'costUsd' | 'model' | 'effort' | 'fallbackUsed'>
      >,
    ] = [true, true, true, true, true, true, true, true]
    expect(checks.every(Boolean)).toBe(true)
  })
})

const workflow = {
  schemaVersion: 1,
  name: 'demo',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'n1', type: 'notify.slack@1', config: { connection: 'team', text: 'hi' } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
}

const ref = { id: 'att-00001', mediaType: 'application/pdf', name: 'receipt.pdf', bytes: 1234 }
const flag = { nodeId: 'n1', pointer: '/config/connection', code: 'new_egress_target', message: 'new target' }
const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
const question = { id: 'q1', text: 'Which folder?', options: ['A', 'B'], default: 'A' }

const workflowBody = { kind: 'workflow', workflow, summary: 'ok', flags: [flag], needsConfirmation: true }
const questionsBody = { kind: 'questions', questions: [question], summary: 'need info' }
const unsupportedBody = { kind: 'unsupported', reason: 'no node', nearest: 'http.request@1', summary: 'cannot' }

const meta = {
  rounds: [
    {
      index: 0,
      issues: [{ stage: 3, pointer: '/nodes/1/config', code: 'config_required', message: 'missing', hint: 'add it' }],
      usage,
      durationMs: 12,
      targeted: ['n1'],
    },
  ],
  usage,
  costUsd: 0.5,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  fallbackUsed: false,
}

const planParams = {
  planId: 'plan-1',
  text: 'send a slack message',
  turns: [],
  attachments: [],
  effort: 'medium',
}

const record = {
  planId: 'plan-1',
  createdAt: 1,
  status: 'planned',
  effort: 'high',
  model: 'claude-sonnet-5-5',
  requestText: 'send a slack message',
  attachments: [ref],
  result: workflowBody,
  meta,
  error: null,
  flagKeys: [flagKey(flag)],
  workflowId: null,
  confirmed: null,
}

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
}

function ok(method: string, params: unknown): boolean {
  return validateParams(method, params).ok
}

describe('plan params', () => {
  it('accepts a minimal request and a full one', () => {
    expect(ok('plan', planParams)).toBe(true)
    expect(
      ok('plan', {
        ...planParams,
        turns: [
          { role: 'user', text: 'first', attachments: [ref], answers: { q1: 'A' } },
          { role: 'assistant', text: 'ok', result: workflowBody },
          { role: 'assistant', text: 'ask', result: questionsBody },
          { role: 'assistant', text: 'no', result: unsupportedBody },
        ],
        attachments: [ref],
        workflowId: 'w-1',
        selection: { nodeId: 'n1' },
        effort: 'xhigh',
      }),
    ).toBe(true)
  })

  it('accepts every effort level and nothing else', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(ok('plan', { ...planParams, effort })).toBe(true)
    for (const effort of ['', 'none', 'MEDIUM', 3, null]) expect(ok('plan', { ...planParams, effort })).toBe(false)
  })

  it('rejects unknown properties and missing fields', () => {
    expect(ok('plan', { ...planParams, extra: 1 })).toBe(false)
    for (const key of Object.keys(planParams)) expect(ok('plan', without(planParams, key)), key).toBe(false)
    expect(ok('plan', { ...planParams, selection: { nodeId: 'n1', extra: 1 } })).toBe(false)
    expect(ok('plan', { ...planParams, selection: {} })).toBe(false)
  })

  it('bounds the text, the turns and the attachments', () => {
    expect(ok('plan', { ...planParams, text: 'x'.repeat(8000) })).toBe(true)
    expect(ok('plan', { ...planParams, text: 'x'.repeat(8001) })).toBe(false)
    expect(ok('plan', { ...planParams, text: '' })).toBe(false)
    const turn = { role: 'user', text: 'hi' }
    expect(ok('plan', { ...planParams, turns: Array.from({ length: 40 }, () => turn) })).toBe(true)
    expect(ok('plan', { ...planParams, turns: Array.from({ length: 41 }, () => turn) })).toBe(false)
    expect(ok('plan', { ...planParams, attachments: Array.from({ length: 5 }, () => ref) })).toBe(true)
    expect(ok('plan', { ...planParams, attachments: Array.from({ length: 6 }, () => ref) })).toBe(false)
  })

  it('checks the planId and workflowId', () => {
    expect(ok('plan', { ...planParams, planId: '' })).toBe(false)
    expect(ok('plan', { ...planParams, planId: 'x'.repeat(129) })).toBe(false)
    expect(ok('plan', { ...planParams, planId: 7 })).toBe(false)
    expect(ok('plan', { ...planParams, workflowId: '' })).toBe(false)
  })

  it('validates each turn: role, size, attachments and a closed shape', () => {
    const turn = (extra: Record<string, unknown>) => ({ ...planParams, turns: [{ role: 'user', text: 'hi', ...extra }] })
    expect(ok('plan', turn({}))).toBe(true)
    expect(ok('plan', turn({ role: 'system' }))).toBe(false)
    expect(ok('plan', turn({ text: 'x'.repeat(8000) }))).toBe(true)
    expect(ok('plan', turn({ text: 'x'.repeat(8001) }))).toBe(false)
    expect(ok('plan', turn({ attachments: Array.from({ length: 6 }, () => ref) }))).toBe(false)
    expect(ok('plan', turn({ answers: { q1: 1 } }))).toBe(false)
    expect(ok('plan', turn({ result: { kind: 'other' } }))).toBe(false)
    expect(ok('plan', turn({ extra: true }))).toBe(false)
  })

  it('validates the attachment refs inside the request', () => {
    const withRef = (value: unknown) => ({ ...planParams, attachments: [value] })
    expect(ok('plan', withRef(ref))).toBe(true)
    expect(ok('plan', withRef({ ...ref, text: 'file contents' }))).toBe(false)
    expect(ok('plan', withRef({ ...ref, data: 'AAAA' }))).toBe(false)
  })
})

describe('AttachmentRefSchema', () => {
  const valid = (value: unknown) => Value.Check(AttachmentRefSchema, value)

  it('accepts ids of 8 to 64 safe characters', () => {
    expect(valid(ref)).toBe(true)
    expect(valid({ ...ref, id: 'a'.repeat(8) })).toBe(true)
    expect(valid({ ...ref, id: 'a'.repeat(64) })).toBe(true)
    expect(valid({ ...ref, id: 'Ab_-0123' })).toBe(true)
  })

  it('rejects short, long and unsafe ids', () => {
    for (const id of ['a'.repeat(7), 'a'.repeat(65), '', '../etc/passwd', 'abc/defgh', 'abc.defgh', 'abcd efgh', 'abcdefg\n', '%2e%2e%2e%2e', 'abcdefgh\0']) {
      expect(valid({ ...ref, id }), JSON.stringify(id)).toBe(false)
    }
  })

  it('accepts the supported media types and nothing else', () => {
    for (const mediaType of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'text/markdown']) {
      expect(valid({ ...ref, mediaType })).toBe(true)
    }
    for (const mediaType of ['application/zip', 'image/svg+xml', 'text/html', 'PDF', '']) {
      expect(valid({ ...ref, mediaType })).toBe(false)
    }
  })

  it('bounds the name and the byte count', () => {
    expect(valid({ ...ref, name: 'n' })).toBe(true)
    expect(valid({ ...ref, name: 'n'.repeat(255) })).toBe(true)
    expect(valid({ ...ref, name: '' })).toBe(false)
    expect(valid({ ...ref, name: 'n'.repeat(256) })).toBe(false)
    expect(valid({ ...ref, bytes: 0 })).toBe(true)
    expect(valid({ ...ref, bytes: -1 })).toBe(false)
    expect(valid({ ...ref, bytes: 1.5 })).toBe(false)
    expect(valid({ ...ref, bytes: '5' })).toBe(false)
  })

  it('is closed and needs all four fields', () => {
    expect(valid({ ...ref, extra: 1 })).toBe(false)
    for (const key of Object.keys(ref)) expect(valid(without(ref, key)), key).toBe(false)
  })
})

describe('FlagSchema and PlanQuestionSchema', () => {
  it('accepts the three flag codes only', () => {
    for (const code of ['attachment_origin', 'new_egress_target', 'untrusted_flow']) {
      expect(Value.Check(FlagSchema, { ...flag, code })).toBe(true)
    }
    expect(Value.Check(FlagSchema, { ...flag, code: 'other' })).toBe(false)
    expect(Value.Check(FlagSchema, { ...flag, extra: 1 })).toBe(false)
    expect(Value.Check(FlagSchema, { nodeId: 'n1', pointer: '/a', code: 'untrusted_flow' })).toBe(false)
  })

  it('is closed for questions', () => {
    expect(Value.Check(PlanQuestionSchema, question)).toBe(true)
    expect(Value.Check(PlanQuestionSchema, { ...question, extra: 1 })).toBe(false)
    expect(Value.Check(PlanQuestionSchema, { id: 'q1', text: 't', options: [] })).toBe(false)
  })
})

describe('PatchOpSchema', () => {
  const node = { id: 'n2', type: 'delay@1', config: { ms: 5 } }
  const valid = (value: unknown) => Value.Check(PatchOpSchema, value)

  it('accepts the five operations', () => {
    expect(valid({ op: 'add_node', node })).toBe(true)
    expect(valid({ op: 'set_config', nodeId: 'n1', config: { a: 1 } })).toBe(true)
    expect(valid({ op: 'set_config', nodeId: 'n1', config: {}, retry: { maxAttempts: 3 }, onError: 'continue' })).toBe(true)
    expect(valid({ op: 'remove_node', nodeId: 'n1' })).toBe(true)
    expect(valid({ op: 'connect', edge: { from: 'a', to: 'b', when: 'yes' } })).toBe(true)
    expect(valid({ op: 'disconnect', from: 'a', to: 'b' })).toBe(true)
  })

  it('rejects an unknown op, extra properties, missing fields and bad node shapes', () => {
    expect(valid({ op: 'rename', nodeId: 'n1' })).toBe(false)
    expect(valid({ op: 'remove_node', nodeId: 'n1', extra: 1 })).toBe(false)
    expect(valid({ op: 'remove_node' })).toBe(false)
    expect(valid({ op: 'add_node', node: { ...node, id: 'Bad Id' } })).toBe(false)
    expect(valid({ op: 'add_node', node: { ...node, extra: 1 } })).toBe(false)
    expect(valid({ op: 'set_config', nodeId: 'n1', config: {}, onError: 'ignore' })).toBe(false)
    expect(valid({ op: 'connect', edge: { from: 'a' } })).toBe(false)
    expect(valid({ op: 'disconnect', from: 'a' })).toBe(false)
  })
})

describe('PlanResultBodySchema', () => {
  const valid = (value: unknown) => Value.Check(PlanResultBodySchema, value)

  it('accepts the three kinds', () => {
    expect(valid(workflowBody)).toBe(true)
    expect(valid({ ...workflowBody, patch: [{ op: 'remove_node', nodeId: 'n1' }] })).toBe(true)
    expect(valid(questionsBody)).toBe(true)
    expect(valid(unsupportedBody)).toBe(true)
  })

  it('rejects unknown kinds, mixed shapes and extra properties', () => {
    expect(valid({ ...workflowBody, kind: 'other' })).toBe(false)
    expect(valid({ ...questionsBody, workflow })).toBe(false)
    expect(valid({ ...unsupportedBody, flags: [] })).toBe(false)
    expect(valid({ kind: 'workflow', workflow, summary: 'x', needsConfirmation: false })).toBe(false)
    expect(valid({ ...workflowBody, workflow: { ...workflow, nodes: [] } })).toBe(false)
  })
})

describe('PlanMetaSchema', () => {
  const valid = (value: unknown) => Value.Check(PlanMetaSchema, value)

  it('accepts a meta record, with or without a cost and a hint', () => {
    expect(valid(meta)).toBe(true)
    expect(valid({ ...meta, costUsd: null })).toBe(true)
    const bare = without(meta.rounds[0]!.issues[0]!, 'hint')
    expect(valid({ ...meta, rounds: [{ ...meta.rounds[0], issues: [bare] }] })).toBe(true)
  })

  it('rejects bad rounds, usage and extra properties', () => {
    expect(valid({ ...meta, extra: 1 })).toBe(false)
    expect(valid({ ...meta, effort: 'ultra' })).toBe(false)
    expect(valid({ ...meta, usage: { inputTokens: 1 } })).toBe(false)
    expect(valid({ ...meta, rounds: [{ ...meta.rounds[0], extra: 1 }] })).toBe(false)
    expect(valid({ ...meta, rounds: [{ ...meta.rounds[0], issues: [{ stage: 5, pointer: '', code: 'c', message: 'm' }] }] })).toBe(false)
  })
})

describe('plan results', () => {
  it('accepts the plan result', () => {
    expect(Value.Check(METHODS.plan.result, { planId: 'plan-1', result: workflowBody, meta })).toBe(true)
    expect(Value.Check(METHODS.plan.result, { planId: 'plan-1', result: questionsBody, meta })).toBe(true)
    expect(Value.Check(METHODS.plan.result, { planId: 'plan-1', meta })).toBe(false)
  })

  it('accepts a plan record in each status and rejects bad ones', () => {
    expect(Value.Check(PlanRecordSchema, record)).toBe(true)
    expect(Value.Check(METHODS.getPlan.result, { plan: record })).toBe(true)
    expect(Value.Check(PlanRecordSchema, { ...record, status: 'failed', result: null, meta: null, error: 'x', flagKeys: [] })).toBe(true)
    expect(Value.Check(PlanRecordSchema, { ...record, status: 'cancelled', model: null, result: null, meta: null, error: 'cancelled' })).toBe(true)
    expect(Value.Check(PlanRecordSchema, { ...record, confirmed: [flagKey(flag)], workflowId: 'w-1' })).toBe(true)
    expect(Value.Check(PlanRecordSchema, { ...record, status: 'running' })).toBe(false)
    expect(Value.Check(PlanRecordSchema, { ...record, extra: 1 })).toBe(false)
  })

  it('keeps attachment bytes and text out of a record shape', () => {
    expect(Value.Check(PlanRecordSchema, { ...record, attachments: [{ ...ref, text: 'secret' }] })).toBe(false)
    expect(Value.Check(PlanRecordSchema, { ...record, attachments: [{ ...ref, data: 'AAAA' }] })).toBe(false)
  })

  it('accepts a plan summary and the list result', () => {
    const summary = { planId: 'plan-1', createdAt: 1, status: 'planned', kind: 'workflow', summary: 'ok', flagCount: 1, workflowId: null }
    expect(Value.Check(PlanSummarySchema, summary)).toBe(true)
    expect(Value.Check(PlanSummarySchema, { ...summary, kind: null, summary: null, status: 'failed' })).toBe(true)
    expect(Value.Check(PlanSummarySchema, { ...summary, kind: 'other' })).toBe(false)
    expect(Value.Check(PlanSummarySchema, { ...summary, extra: 1 })).toBe(false)
    expect(Value.Check(METHODS.listPlans.result, { plans: [summary] })).toBe(true)
    expect(Value.Check(METHODS.cancelPlan.result, { cancelled: true })).toBe(true)
    expect(Value.Check(METHODS.cancelPlan.result, {})).toBe(false)
    expect(Value.Check(METHODS.deployPlan.result, { workflowId: 'w-1' })).toBe(true)
  })
})

describe('the other plan methods', () => {
  it('cancelPlan and getPlan take one closed planId', () => {
    for (const method of ['cancelPlan', 'getPlan']) {
      expect(ok(method, { planId: 'plan-1' })).toBe(true)
      expect(ok(method, {})).toBe(false)
      expect(ok(method, { planId: '' })).toBe(false)
      expect(ok(method, { planId: 'plan-1', extra: 1 })).toBe(false)
    }
  })

  it('listPlans takes an optional limit of 1 to 200', () => {
    expect(ok('listPlans', {})).toBe(true)
    expect(validateParams('listPlans', undefined).ok).toBe(true)
    expect(ok('listPlans', { limit: 1 })).toBe(true)
    expect(ok('listPlans', { limit: 200 })).toBe(true)
    expect(ok('listPlans', { limit: 0 })).toBe(false)
    expect(ok('listPlans', { limit: 201 })).toBe(false)
    expect(ok('listPlans', { limit: 1.5 })).toBe(false)
    expect(ok('listPlans', { extra: 1 })).toBe(false)
  })

  it('deployPlan takes the planId and up to 200 confirmed keys', () => {
    expect(ok('deployPlan', { planId: 'plan-1', confirmed: [] })).toBe(true)
    expect(ok('deployPlan', { planId: 'plan-1', confirmed: [flagKey(flag)] })).toBe(true)
    expect(ok('deployPlan', { planId: 'plan-1', confirmed: Array.from({ length: 200 }, (_, i) => `k${i}`) })).toBe(true)
    expect(ok('deployPlan', { planId: 'plan-1', confirmed: Array.from({ length: 201 }, (_, i) => `k${i}`) })).toBe(false)
    expect(ok('deployPlan', { planId: 'plan-1' })).toBe(false)
    expect(ok('deployPlan', { confirmed: [] })).toBe(false)
    expect(ok('deployPlan', { planId: 'plan-1', confirmed: [1] })).toBe(false)
    expect(ok('deployPlan', { planId: 'plan-1', confirmed: [], extra: 1 })).toBe(false)
  })

  it('keeps the old methods unchanged', () => {
    expect(validateParams('nope', {})).toMatchObject({ ok: false, code: 'UNKNOWN_METHOD' })
    expect(validateParams('listRuns', { limit: 0 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('ping', { extra: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('startRun', { workflowId: 'w' })).toEqual({ ok: true, method: 'startRun', params: { workflowId: 'w' } })
    expect(validateParams('plan', planParams)).toMatchObject({ ok: true, method: 'plan' })
    expect(validateParams('plan', { ...planParams, extra: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('lists the new error codes next to the old ones', () => {
    for (const code of [
      'INVALID_PARAMS',
      'UNKNOWN_METHOD',
      'INVALID_WORKFLOW',
      'NOT_FOUND',
      'ACTIVATION_FAILED',
      'INTERNAL',
      'LLM_UNAVAILABLE',
      'PLAN_INVALID',
      'PLAN_PROVIDER',
      'PLAN_CANCELLED',
      'PLAN_BUSY',
      'PLAN_EXISTS',
      'PLAN_NOT_CONFIRMED',
      'PLAN_DEPLOYED',
      'ATTACHMENT_REJECTED',
    ]) {
      expect(ERROR_CODES as readonly string[]).toContain(code)
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

describe('flagKey', () => {
  it('is the JSON of the three parts, stable across calls and extra properties', () => {
    expect(flagKey(flag)).toBe(JSON.stringify(['n1', '/config/connection', 'new_egress_target']))
    const reworded = { ...flag, message: 'a different message' }
    expect(flagKey(flag)).toBe(flagKey(reworded))
    expect(flagKey(flag)).toBe(flagKey({ ...flag }))
  })

  it('distinguishes flags that differ in one component', () => {
    const base = { nodeId: 'n1', pointer: '/a', code: 'untrusted_flow' }
    const keys = [
      flagKey(base),
      flagKey({ ...base, nodeId: 'n2' }),
      flagKey({ ...base, pointer: '/b' }),
      flagKey({ ...base, code: 'attachment_origin' }),
    ]
    expect(new Set(keys).size).toBe(4)
  })

  it('cannot collide through separator characters', () => {
    const pairs: Array<[Parameters<typeof flagKey>[0], Parameters<typeof flagKey>[0]]> = [
      [
        { nodeId: 'a', pointer: 'b|c', code: 'd' },
        { nodeId: 'a|b', pointer: 'c', code: 'd' },
      ],
      [
        { nodeId: 'a', pointer: 'b', code: 'c' },
        { nodeId: 'a/b', pointer: '', code: 'c' },
      ],
      [
        { nodeId: 'a","b', pointer: 'c', code: 'd' },
        { nodeId: 'a', pointer: 'b","c', code: 'd' },
      ],
      [
        { nodeId: 'a:b', pointer: 'c', code: 'd' },
        { nodeId: 'a', pointer: 'b:c', code: 'd' },
      ],
    ]
    for (const [left, right] of pairs) expect(flagKey(left)).not.toBe(flagKey(right))
  })
})
