import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  EngineEventSchema,
  HOOK_ACTION_TYPES,
  HOOK_CHANNEL_MAX_CHARS,
  HOOK_CHANNEL_MAX_INPUT_CHARS,
  HOOK_CONNECTION_MAX_CHARS,
  HOOK_CONNECTION_MAX_INPUT_CHARS,
  HOOK_COOLDOWN_MS,
  HOOK_EVENTS,
  HOOK_FAILURE_CODES,
  HOOK_FAILURE_COUNT_MAX,
  HOOK_FAILURE_COUNT_MIN,
  HOOK_LOG_DEFAULT_LIMIT,
  HOOK_LOG_MAX_LIMIT,
  HOOK_LOG_MAX_ROWS,
  HOOK_MAX_ITEMS,
  HOOK_OUTCOMES,
  HOOK_RATE_LIMIT,
  HOOK_RATE_WINDOW_MS,
  HookLogEntrySchema,
  HookSchema,
  METHODS,
  validateParams,
} from '../src/index'

const hook = {
  id: '3f2b8c1e-6a4d-4f5b-9c0e-1a2b3c4d5e6f',
  event: 'run.failed',
  scope: { type: 'all' },
  action: { type: 'notify', connection: 'team-slack', channel: '#alerts' },
  enabled: true,
  createdAt: 1000,
  updatedAt: 2000,
}

const entry = { id: 7, hookId: hook.id, at: 5000, event: 'run.failed', workflowId: 'wf-1', outcome: 'ok', code: null }

const save = {
  event: 'run.failed',
  scope: { type: 'workflow', workflowId: 'wf-1' },
  action: { type: 'notify', connection: 'team-slack' },
  enabled: true,
}

describe('hook limits and names', () => {
  it('are the numbers of the plan', () => {
    expect([...HOOK_EVENTS]).toEqual(['run.failed', 'run.succeeded', 'plan.deployed'])
    expect([...HOOK_ACTION_TYPES]).toEqual(['notify', 'deactivateAfterFailures', 'record'])
    expect(HOOK_MAX_ITEMS).toBe(20)
    expect(HOOK_FAILURE_COUNT_MIN).toBe(2)
    expect(HOOK_FAILURE_COUNT_MAX).toBe(20)
    expect(HOOK_COOLDOWN_MS).toBe(60_000)
    expect(HOOK_RATE_LIMIT).toBe(30)
    expect(HOOK_RATE_WINDOW_MS).toBe(600_000)
    expect(HOOK_LOG_MAX_ROWS).toBe(500)
    expect(HOOK_LOG_DEFAULT_LIMIT).toBe(50)
    expect(HOOK_LOG_MAX_LIMIT).toBe(200)
    expect(HOOK_CHANNEL_MAX_CHARS).toBe(80)
    expect(HOOK_CONNECTION_MAX_CHARS).toBeGreaterThanOrEqual(64)
    expect([...HOOK_OUTCOMES]).toEqual(['ok', 'failed', 'skipped_cooldown', 'rate_limited', 'blocked_by_rule', 'skipped_inactive'])
    expect([...HOOK_FAILURE_CODES]).toEqual(['connection', 'timeout', 'http_status', 'slack_error', 'unknown'])
  })

  it('lists the hook error codes', () => {
    for (const code of ['HOOK_INVALID', 'HOOK_FULL', 'HOOK_NOT_FOUND']) expect(ERROR_CODES as readonly string[]).toContain(code)
  })
})

describe('HookSchema', () => {
  const valid = (value: unknown) => Value.Check(HookSchema, value)

  it('accepts each event, each scope and each action', () => {
    for (const event of HOOK_EVENTS) expect(valid({ ...hook, event }), event).toBe(true)
    expect(valid({ ...hook, scope: { type: 'workflow', workflowId: 'wf-1' } })).toBe(true)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'team-slack' } })).toBe(true)
    expect(valid({ ...hook, action: { type: 'deactivateAfterFailures', count: 2 } })).toBe(true)
    expect(valid({ ...hook, action: { type: 'deactivateAfterFailures', count: 20 } })).toBe(true)
    expect(valid({ ...hook, action: { type: 'record' } })).toBe(true)
    expect(valid({ ...hook, enabled: false })).toBe(true)
  })

  it('rejects unknown events, scopes and actions, extra fields, missing fields and wrong types', () => {
    expect(valid({ ...hook, event: 'run.started' })).toBe(false)
    expect(valid({ ...hook, event: 'workflow.deactivated' })).toBe(false)
    expect(valid({ ...hook, scope: { type: 'folder' } })).toBe(false)
    expect(valid({ ...hook, scope: { type: 'all', workflowId: 'wf-1' } })).toBe(false)
    expect(valid({ ...hook, scope: { type: 'workflow' } })).toBe(false)
    expect(valid({ ...hook, scope: { type: 'workflow', workflowId: '' } })).toBe(false)
    expect(valid({ ...hook, scope: 'all' })).toBe(false)
    expect(valid({ ...hook, action: { type: 'startRun' } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'record', connection: 'x' } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'x', count: 3 } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'notify' } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'notify', connection: '' } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'x', channel: '' } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'deactivateAfterFailures' } })).toBe(false)
    expect(valid({ ...hook, extra: 1 })).toBe(false)
    for (const key of ['id', 'event', 'scope', 'action', 'enabled', 'createdAt', 'updatedAt'] as const) {
      const rest: Record<string, unknown> = { ...hook }
      delete rest[key]
      expect(valid(rest), key).toBe(false)
    }
    expect(valid({ ...hook, id: '' })).toBe(false)
    expect(valid({ ...hook, enabled: 1 })).toBe(false)
    expect(valid({ ...hook, createdAt: '1' })).toBe(false)
  })

  it('limits the count to 2 to 20 whole numbers, the channel to 80 characters and the connection name', () => {
    for (const count of [0, 1, 21, 2.5, -3]) expect(valid({ ...hook, action: { type: 'deactivateAfterFailures', count } }), String(count)).toBe(false)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'x', channel: 'c'.repeat(HOOK_CHANNEL_MAX_CHARS) } })).toBe(true)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'x', channel: 'c'.repeat(HOOK_CHANNEL_MAX_CHARS + 1) } })).toBe(false)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'c'.repeat(HOOK_CONNECTION_MAX_CHARS) } })).toBe(true)
    expect(valid({ ...hook, action: { type: 'notify', connection: 'c'.repeat(HOOK_CONNECTION_MAX_CHARS + 1) } })).toBe(false)
  })
})

describe('HookLogEntrySchema', () => {
  const valid = (value: unknown) => Value.Check(HookLogEntrySchema, value)

  it('accepts every outcome, and a code for a failed row', () => {
    for (const outcome of HOOK_OUTCOMES) expect(valid({ ...entry, outcome }), outcome).toBe(true)
    for (const code of HOOK_FAILURE_CODES) expect(valid({ ...entry, outcome: 'failed', code }), code).toBe(true)
  })

  it('rejects a free text code, unknown outcomes, extra and missing fields', () => {
    expect(valid({ ...entry, code: 'Slack said channel_not_found' })).toBe(false)
    expect(valid({ ...entry, outcome: 'sent' })).toBe(false)
    expect(valid({ ...entry, event: 'run.started' })).toBe(false)
    expect(valid({ ...entry, extra: 1 })).toBe(false)
    expect(valid({ ...entry, id: 0 })).toBe(false)
    for (const key of ['id', 'hookId', 'at', 'event', 'workflowId', 'outcome', 'code'] as const) {
      const rest: Record<string, unknown> = { ...entry }
      delete rest[key]
      expect(valid(rest), key).toBe(false)
    }
  })
})

describe('listHooks', () => {
  it('takes no params', () => {
    expect(validateParams('listHooks', {})).toEqual({ ok: true, method: 'listHooks', params: {} })
    expect(validateParams('listHooks', { limit: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns at most 20 hooks', () => {
    const result = (count: number) => ({ hooks: Array.from({ length: count }, (_, index) => ({ ...hook, id: `hook-${index}` })) })
    expect(Value.Check(METHODS.listHooks.result, result(0))).toBe(true)
    expect(Value.Check(METHODS.listHooks.result, result(20))).toBe(true)
    expect(Value.Check(METHODS.listHooks.result, result(21))).toBe(false)
    expect(Value.Check(METHODS.listHooks.result, { hooks: [{ ...hook, extra: 1 }] })).toBe(false)
  })
})

describe('saveHook', () => {
  const ok = (params: unknown) => validateParams('saveHook', params).ok

  it('takes an optional id, an event, a scope, an action and the enabled flag', () => {
    expect(validateParams('saveHook', save)).toEqual({ ok: true, method: 'saveHook', params: save })
    expect(ok({ ...save, id: 'hook-1' })).toBe(true)
    expect(ok({ ...save, scope: { type: 'all' }, event: 'plan.deployed', action: { type: 'record' } })).toBe(true)
    expect(ok({ ...save, action: { type: 'deactivateAfterFailures', count: 3 } })).toBe(true)
    expect(ok({ ...save, action: { type: 'notify', connection: 'team', channel: '#ops' } })).toBe(true)
  })

  it('rejects unknown fields at every level and wrong shapes', () => {
    expect(ok({ ...save, extra: 1 })).toBe(false)
    expect(ok({ ...save, createdAt: 1 })).toBe(false)
    expect(ok({ ...save, scope: { type: 'all', workflowId: 'wf' } })).toBe(false)
    expect(ok({ ...save, action: { type: 'record', channel: '#x' } })).toBe(false)
    expect(ok({ ...save, action: { type: 'notify', connection: 'x', secret: 'y' } })).toBe(false)
    expect(ok({ ...save, action: { type: 'runWorkflow', workflowId: 'w' } })).toBe(false)
    expect(ok({ ...save, event: 'run.finished' })).toBe(false)
    expect(ok({ ...save, enabled: 'yes' })).toBe(false)
    for (const key of ['event', 'scope', 'action', 'enabled'] as const) {
      const rest: Record<string, unknown> = { ...save }
      delete rest[key]
      expect(ok(rest), key).toBe(false)
    }
    expect(ok({ ...save, id: '' })).toBe(false)
    expect(ok({ ...save, action: { type: 'deactivateAfterFailures', count: 2.5 } })).toBe(false)
    expect(ok({ ...save, action: { type: 'deactivateAfterFailures', count: '3' } })).toBe(false)
  })

  it('leaves the range of the count and the grammar of the text to the engine but refuses an absurd payload', () => {
    expect(ok({ ...save, action: { type: 'deactivateAfterFailures', count: 1 } })).toBe(true)
    expect(ok({ ...save, action: { type: 'deactivateAfterFailures', count: 5000 } })).toBe(true)
    expect(ok({ ...save, action: { type: 'notify', connection: 'c'.repeat(HOOK_CONNECTION_MAX_INPUT_CHARS) } })).toBe(true)
    expect(ok({ ...save, action: { type: 'notify', connection: 'c'.repeat(HOOK_CONNECTION_MAX_INPUT_CHARS + 1) } })).toBe(false)
    expect(ok({ ...save, action: { type: 'notify', connection: 'x', channel: 'c'.repeat(HOOK_CHANNEL_MAX_INPUT_CHARS) } })).toBe(true)
    expect(ok({ ...save, action: { type: 'notify', connection: 'x', channel: 'c'.repeat(HOOK_CHANNEL_MAX_INPUT_CHARS + 1) } })).toBe(false)
  })

  it('does not put the text into the problems of a bad request', () => {
    const marker = 'HOOK-MARKER-5b1e'
    const result = validateParams('saveHook', { ...save, action: { type: 'notify', connection: marker.repeat(HOOK_CONNECTION_MAX_INPUT_CHARS) } })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('returns one hook', () => {
    expect(Value.Check(METHODS.saveHook.result, { hook })).toBe(true)
    expect(Value.Check(METHODS.saveHook.result, { hook: { ...hook, enabled: 'x' } })).toBe(false)
    expect(Value.Check(METHODS.saveHook.result, {})).toBe(false)
    expect(Value.Check(METHODS.saveHook.result, { hook, extra: 1 })).toBe(false)
  })
})

describe('deleteHook', () => {
  it('takes an id and says whether a hook was deleted', () => {
    expect(validateParams('deleteHook', { id: 'hook-1' })).toEqual({ ok: true, method: 'deleteHook', params: { id: 'hook-1' } })
    expect(validateParams('deleteHook', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteHook', { id: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteHook', { id: 'hook-1', event: 'run.failed' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(Value.Check(METHODS.deleteHook.result, { deleted: true })).toBe(true)
    expect(Value.Check(METHODS.deleteHook.result, { deleted: 'yes' })).toBe(false)
  })
})

describe('listHookLog', () => {
  it('takes an optional limit of 1 to 200 and an optional hook id', () => {
    expect(validateParams('listHookLog', {})).toEqual({ ok: true, method: 'listHookLog', params: {} })
    expect(validateParams('listHookLog', { limit: 1 }).ok).toBe(true)
    expect(validateParams('listHookLog', { limit: 200, hookId: 'hook-1' }).ok).toBe(true)
    for (const limit of [0, 201, -1, 1.5, '5']) expect(validateParams('listHookLog', { limit }), String(limit)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('listHookLog', { hookId: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('listHookLog', { workflowId: 'w' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns at most 200 entries', () => {
    const result = (count: number) => ({ entries: Array.from({ length: count }, (_, index) => ({ ...entry, id: index + 1 })) })
    expect(Value.Check(METHODS.listHookLog.result, result(0))).toBe(true)
    expect(Value.Check(METHODS.listHookLog.result, result(200))).toBe(true)
    expect(Value.Check(METHODS.listHookLog.result, result(201))).toBe(false)
    expect(Value.Check(METHODS.listHookLog.result, { entries: [{ ...entry, extra: 1 }] })).toBe(false)
  })
})

describe('the plan.deployed event', () => {
  const valid = (value: unknown) => Value.Check(EngineEventSchema, value)

  it('carries the workflow and the plan and nothing else', () => {
    expect(valid({ type: 'plan.deployed', at: 1, workflowId: 'w', planId: 'p' })).toBe(true)
    expect(valid({ type: 'plan.deployed', at: 1, workflowId: 'w' })).toBe(false)
    expect(valid({ type: 'plan.deployed', at: 1, planId: 'p' })).toBe(false)
    expect(valid({ type: 'plan.deployed', at: 1, workflowId: '', planId: 'p' })).toBe(false)
    expect(valid({ type: 'plan.deployed', at: 1, workflowId: 'w', planId: 'p', extra: true })).toBe(false)
    expect(valid({ type: 'plan.deployed', workflowId: 'w', planId: 'p' })).toBe(false)
  })
})
