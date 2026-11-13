import { describe, expect, it } from 'vitest'
import { HOOK_CHANNEL_MAX_CHARS, checkHookInput, hookKey, type HookCheckEnv, type HookConnectionKind, type HookInput, type HookProblem } from '../src/index'

const kinds: Record<string, HookConnectionKind> = { 'team-slack': 'slack', api: 'other' }

function env(overrides: Partial<HookCheckEnv> = {}): HookCheckEnv {
  return { workflowExists: (id) => id === 'wf-1', connectionKind: (name) => kinds[name] ?? 'missing', notifyForbidden: false, ...overrides }
}

const record: HookInput = { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true }
const notify = (connection: string, channel?: string): HookInput => ({ ...record, action: { type: 'notify', connection, ...(channel === undefined ? {} : { channel }) } })

function problems(input: HookInput, overrides: Partial<HookCheckEnv> = {}): string[] {
  const checked = checkHookInput(input, env(overrides))
  return checked.ok ? [] : checked.problems.map((problem: HookProblem) => `${problem.field}.${problem.rule}`)
}

function accepted(input: HookInput, overrides: Partial<HookCheckEnv> = {}): HookInput {
  const checked = checkHookInput(input, env(overrides))
  if (!checked.ok) throw new Error(`expected a valid hook, got ${JSON.stringify(checked.problems)}`)
  return checked.input
}

describe('checkHookInput', () => {
  it('accepts every action and hands back the normalised hook', () => {
    expect(accepted(record)).toEqual(record)
    expect(accepted(notify('team-slack', '  #e\u0301quipe '))).toEqual({ ...record, action: { type: 'notify', connection: 'team-slack', channel: '#équipe' } })
    expect(accepted(notify('team-slack', '   ')).action).toEqual({ type: 'notify', connection: 'team-slack' })
    expect(accepted({ ...record, action: { type: 'deactivateAfterFailures', count: 2 } }).action).toEqual({ type: 'deactivateAfterFailures', count: 2 })
    expect(accepted({ ...record, scope: { type: 'workflow', workflowId: 'wf-1' }, enabled: false })).toEqual({ ...record, scope: { type: 'workflow', workflowId: 'wf-1' }, enabled: false })
  })

  it('drops a field that does not belong to the action or the scope', () => {
    const loose = { ...record, scope: { type: 'all', workflowId: 'x' }, action: { type: 'record', connection: 'y' } } as unknown as HookInput
    expect(accepted(loose)).toEqual(record)
  })

  it('names the problem of each check', () => {
    expect(problems({ ...record, scope: { type: 'workflow', workflowId: 'gone' } })).toEqual(['scope.unknown_workflow'])
    expect(problems(notify(''))).toEqual(['connection.empty'])
    expect(problems(notify('nobody'))).toEqual(['connection.unknown_connection'])
    expect(problems(notify('api'))).toEqual(['connection.not_slack_connection'])
    expect(problems(notify('a\nb'))).toEqual(['connection.control_character'])
    expect(problems(notify('team-slack', 'a b'))).toEqual(['channel.whitespace'])
    expect(problems(notify('team-slack', 'c'.repeat(HOOK_CHANNEL_MAX_CHARS + 1)))).toEqual(['channel.too_long'])
    expect(problems(notify('team-slack'), { notifyForbidden: true })).toEqual(['action.forbidden_by_rule'])
    for (const count of [-1, 0, 1, 21, 2.5, Number.NaN]) expect(problems({ ...record, action: { type: 'deactivateAfterFailures', count } }), String(count)).toEqual(['count.out_of_range'])
    expect(problems({ ...record, event: 'plan.deployed', action: { type: 'deactivateAfterFailures', count: 3 } })).toEqual(['action.only_for_run_failed'])
  })

  it('reports every problem in the order of the fields', () => {
    expect(problems({ ...notify('nobody', 'a b'), scope: { type: 'workflow', workflowId: 'gone' } }, { notifyForbidden: true })).toEqual([
      'scope.unknown_workflow',
      'connection.unknown_connection',
      'channel.whitespace',
      'action.forbidden_by_rule',
    ])
    expect(problems({ ...record, event: 'run.succeeded', action: { type: 'deactivateAfterFailures', count: 1 } })).toEqual(['count.out_of_range', 'action.only_for_run_failed'])
  })

  it('asks the environment for the connection only when the name has passed the character rules', () => {
    const asked: string[] = []
    problems(notify('a\nb'), { connectionKind: (name) => (asked.push(name), 'slack') })
    problems(notify('team-slack'), { connectionKind: (name) => (asked.push(name), 'slack') })
    expect(asked).toEqual(['team-slack'])
  })

  it('holds a disabled hook to the text rules but not to the connections and the rules, which are checked when it is enabled', () => {
    const off = (input: HookInput): HookInput => ({ ...input, enabled: false })
    expect(problems(off(notify('nobody')))).toEqual([])
    expect(problems(off(notify('api')))).toEqual([])
    expect(problems(off(notify('team-slack')), { notifyForbidden: true })).toEqual([])
    expect(problems(off(notify('nobody', 'a b')), { notifyForbidden: true })).toEqual(['channel.whitespace'])
    expect(problems(off(notify('a\nb')))).toEqual(['connection.control_character'])
    expect(problems(off(notify('')))).toEqual(['connection.empty'])
    expect(problems({ ...off(record), scope: { type: 'workflow', workflowId: 'gone' } })).toEqual(['scope.unknown_workflow'])
    expect(problems(off({ ...record, event: 'plan.deployed', action: { type: 'deactivateAfterFailures', count: 3 } }))).toEqual(['action.only_for_run_failed'])
    expect(problems(notify('nobody'))).toEqual(['connection.unknown_connection'])
    expect(problems(notify('team-slack'), { notifyForbidden: true })).toEqual(['action.forbidden_by_rule'])
    expect(accepted(off(notify('nobody', ' #a '))).action).toEqual({ type: 'notify', connection: 'nobody', channel: '#a' })
  })

  it('does not ask the environment about a connection for a disabled hook', () => {
    const asked: string[] = []
    problems({ ...notify('team-slack'), enabled: false }, { connectionKind: (name) => (asked.push(name), 'slack') })
    expect(asked).toEqual([])
  })

  it('does not ask whether a workflow exists for the scope all', () => {
    let asked = 0
    problems(record, { workflowExists: () => (asked += 1, true) })
    expect(asked).toBe(0)
  })
})

describe('hookKey', () => {
  it('is the same for the same event, scope and action, whatever enabled says', () => {
    expect(hookKey(notify('team-slack', '#a'))).toBe(hookKey({ ...notify('team-slack', '#a'), enabled: false }))
    expect(hookKey(record)).toBe(hookKey({ ...record }))
  })

  it('differs when the event, the scope, the action, the connection, the channel or the count differ', () => {
    const keys = [
      hookKey(record),
      hookKey({ ...record, event: 'run.succeeded' }),
      hookKey({ ...record, scope: { type: 'workflow', workflowId: 'wf-1' } }),
      hookKey({ ...record, scope: { type: 'workflow', workflowId: 'wf-2' } }),
      hookKey(notify('team-slack')),
      hookKey(notify('team-slack', '#a')),
      hookKey(notify('team-slack', '#b')),
      hookKey(notify('api')),
      hookKey({ ...record, action: { type: 'deactivateAfterFailures', count: 2 } }),
      hookKey({ ...record, action: { type: 'deactivateAfterFailures', count: 3 } }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})
