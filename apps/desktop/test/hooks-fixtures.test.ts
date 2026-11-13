// @vitest-environment node
import { HOOK_MAX_ITEMS, HOOK_OUTCOMES, HookLogEntrySchema, HookSchema, hookKey, type Hook } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { hookConnections, hookFixtures, hookLogFixtures } from '../src/fixtures/hooks'

const keyOf = (hook: Hook): string => hookKey({ event: hook.event, scope: hook.scope, action: hook.action, enabled: hook.enabled })

describe('the hook fixtures', () => {
  it('are hooks that the protocol accepts, each set with distinct ids and distinct hooks', () => {
    for (const [name, list] of Object.entries(hookFixtures)) {
      if (!Array.isArray(list)) continue
      for (const hook of list) expect(Value.Check(HookSchema, hook), `${name} ${hook.id}`).toBe(true)
      expect(new Set(list.map((hook) => hook.id)).size, name).toBe(list.length)
      expect(new Set(list.map(keyOf)).size, name).toBe(list.length)
    }
  })

  it('hold the limit of hooks in one set, and one more kind of every action and event in the common set', () => {
    expect(hookFixtures.full).toHaveLength(HOOK_MAX_ITEMS)
    expect(new Set(hookFixtures.some.map((hook) => hook.action.type))).toEqual(new Set(['notify', 'deactivateAfterFailures', 'record']))
    expect(new Set(hookFixtures.some.map((hook) => hook.event))).toEqual(new Set(['run.failed', 'run.succeeded', 'plan.deployed']))
    expect(hookFixtures.some.some((hook) => !hook.enabled)).toBe(true)
  })

  it('name connections of the fixture list, except in the set about connections that are gone', () => {
    const names = new Set(hookConnections.map((entry) => entry.name))
    for (const hook of hookFixtures.some) if (hook.action.type === 'notify') expect(names.has(hook.action.connection), hook.id).toBe(true)
    expect(hookFixtures.problems.some((hook) => hook.action.type === 'notify' && !names.has(hook.action.connection))).toBe(true)
  })

  it('have log rows that the protocol accepts, oldest first, with rising ids, as the fake engine keeps them', () => {
    for (const [name, rows] of Object.entries(hookLogFixtures)) {
      for (const row of rows) expect(Value.Check(HookLogEntrySchema, row), `${name} ${row.id}`).toBe(true)
      expect(rows.map((row) => row.id), name).toEqual(rows.map((_, index) => index + 1))
      expect([...rows].sort((a, b) => a.at - b.at), name).toEqual(rows)
    }
  })

  it('cover every outcome and every failure code in the mixed log, and a hook and a workflow that are gone', () => {
    const rows = hookLogFixtures.mixed
    expect(new Set(rows.map((row) => row.outcome))).toEqual(new Set(HOOK_OUTCOMES))
    expect(new Set(rows.flatMap((row) => (row.code === null ? [] : [row.code])))).toEqual(new Set(['connection', 'timeout', 'http_status', 'slack_error', 'unknown']))
    expect(rows.every((row) => (row.code === null) === (row.outcome !== 'failed'))).toBe(true)
    expect(rows.some((row) => !hookFixtures.some.some((hook) => hook.id === row.hookId))).toBe(true)
    expect(rows.some((row) => row.workflowId === 'wf-deleted')).toBe(true)
    expect(hookLogFixtures.many).toHaveLength(50)
  })
})
