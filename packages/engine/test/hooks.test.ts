import { SLACK_CHANNEL_MAX, isSlackChannel } from '@rill/nodes-core'
import { HOOK_CHANNEL_MAX_CHARS, HOOK_MAX_ITEMS, HookLogEntrySchema, HookSchema, type HookInput, type HookProblem } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine'
import { HookFullError, HookInvalidError, HookNotFoundError } from '../src/hooks'
import { echoWorkflow, hookInput, notify, openEngine } from './hook-helpers'

const engines: Engine[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function setup(options: Parameters<typeof openEngine>[0] = {}) {
  let clock = 1_000
  const opened = openEngine({ now: () => (clock += 10), ...options })
  engines.push(opened.engine)
  return opened
}

function problemsOf(action: () => unknown): HookProblem[] {
  try {
    action()
  } catch (error) {
    if (error instanceof HookInvalidError) return error.problemList
    throw error
  }
  throw new Error('expected the hook to be refused')
}

const rules = (problems: HookProblem[]) => problems.map((problem) => `${problem.field}.${problem.rule}`)

describe('Engine.saveHook', () => {
  it('starts with no hooks and saves a record hook that the protocol schema accepts', () => {
    const { engine } = setup()
    expect(engine.listHooks()).toEqual([])
    const hook = engine.saveHook(hookInput())
    expect(hook).toMatchObject({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    expect(hook.id).toMatch(/\S/)
    expect(hook.createdAt).toBe(hook.updatedAt)
    expect(Value.Check(HookSchema, hook)).toBe(true)
    expect(engine.listHooks()).toEqual([hook])
  })

  it('saves each action and each event, and a workflow scope for a workflow that exists', () => {
    const { engine } = setup()
    const workflowId = engine.deploy(echoWorkflow('w'))
    const saved = [
      engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack', '#ops'), scope: { type: 'workflow', workflowId } })),
      engine.saveHook(hookInput({ event: 'plan.deployed', action: notify('hook-slack') })),
      engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 3 }, scope: { type: 'workflow', workflowId } })),
      engine.saveHook(hookInput({ event: 'run.succeeded', enabled: false })),
    ]
    expect(engine.listHooks()).toEqual(saved)
    for (const hook of saved) expect(Value.Check(HookSchema, hook)).toBe(true)
    expect(saved[0]).toMatchObject({ action: { type: 'notify', connection: 'team-slack', channel: '#ops' }, scope: { type: 'workflow', workflowId } })
    expect(saved[3]).toMatchObject({ enabled: false })
  })

  it('lists the hooks in the order of their creation, and an edit does not move one', () => {
    const { engine } = setup()
    const first = engine.saveHook(hookInput({ event: 'run.succeeded' }))
    const second = engine.saveHook(hookInput({ event: 'plan.deployed' }))
    const third = engine.saveHook(hookInput({ event: 'run.failed' }))
    engine.saveHook({ ...hookInput({ event: 'run.succeeded', enabled: false }), id: first.id })
    expect(engine.listHooks().map((hook) => hook.id)).toEqual([first.id, second.id, third.id])
  })

  it('trims and composes the channel, and leaves out an empty channel', () => {
    const { engine } = setup()
    expect(engine.saveHook(hookInput({ action: notify('team-slack', '  #e\u0301quipe  ') })).action).toEqual({ type: 'notify', connection: 'team-slack', channel: '#\u00e9quipe' })
    expect(engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack', '') })).action).toEqual({ type: 'notify', connection: 'team-slack' })
    expect(engine.saveHook(hookInput({ event: 'plan.deployed', action: notify('team-slack', '   ') })).action).toEqual({ type: 'notify', connection: 'team-slack' })
  })

  it('updates a hook in place: same id and creation time, new values and a new update time', () => {
    const { engine } = setup()
    const hook = engine.saveHook(hookInput({ action: notify('team-slack') }))
    const edited = engine.saveHook({ ...hookInput({ event: 'run.succeeded', action: notify('hook-slack'), enabled: false }), id: hook.id })
    expect(edited).toMatchObject({ id: hook.id, createdAt: hook.createdAt, event: 'run.succeeded', action: { type: 'notify', connection: 'hook-slack' }, enabled: false })
    expect(edited.updatedAt).toBeGreaterThan(hook.updatedAt)
    expect(engine.listHooks()).toEqual([edited])
  })

  it('answers HookNotFoundError for an edit of an unknown id, after it has checked the hook', () => {
    const { engine } = setup()
    expect(() => engine.saveHook({ ...hookInput(), id: 'missing' })).toThrow(HookNotFoundError)
    expect(rules(problemsOf(() => engine.saveHook({ ...hookInput({ action: notify('') }), id: 'missing' })))).toEqual(['connection.empty'])
    expect(engine.listHooks()).toEqual([])
  })

  it('does not let a failed save change a stored hook', () => {
    const { engine } = setup()
    const hook = engine.saveHook(hookInput({ action: notify('team-slack', '#a') }))
    expect(() => engine.saveHook({ ...hookInput({ action: notify('nope') }), id: hook.id })).toThrow(HookInvalidError)
    expect(engine.listHooks()).toEqual([hook])
  })
})

describe('the checks of a hook at save time', () => {
  it('refuses a workflow scope for a workflow that does not exist', () => {
    const { engine } = setup()
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ scope: { type: 'workflow', workflowId: 'missing' } }))))).toEqual(['scope.unknown_workflow'])
  })

  it('refuses a connection that is missing, not saved, or not a Slack connection', () => {
    const { engine } = setup()
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('') }))))).toEqual(['connection.empty'])
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('nobody') }))))).toEqual(['connection.unknown_connection'])
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('api') }))))).toEqual(['connection.not_slack_connection'])
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('legacy') }))))).toEqual(['connection.not_slack_connection'])
    expect(engine.listHooks()).toEqual([])
  })

  it('looks the connection up by its exact spelling', () => {
    const { engine } = setup()
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('TEAM-SLACK') }))))).toEqual(['connection.unknown_connection'])
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify(' team-slack ') }))))).toEqual(['connection.unknown_connection'])
  })

  it('accepts a bot connection and an old webhook connection, with or without a default channel', () => {
    const { engine } = setup()
    for (const [index, name] of ['team-slack', 'bare-bot', 'hook-slack'].entries()) {
      expect(engine.saveHook(hookInput({ event: HOOK_EVENTS_FOR_TEST[index]!, action: notify(name) })).action).toMatchObject({ connection: name })
    }
  })

  it('refuses a connection that holds a character a name may not have, without naming it', () => {
    const { engine } = setup()
    const cases: Array<[string, string]> = [
      ['a\nb', 'connection.control_character'],
      ['a\u2028b', 'connection.line_separator'],
      ['a\u202eb', 'connection.bidi_format'],
      ['a\u200bb', 'connection.format_character'],
      ['c'.repeat(500), 'connection.too_long'],
    ]
    for (const [name, rule] of cases) expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify(name) })))), rule).toEqual([rule])
  })

  it('refuses a channel with a space, a hidden character or more than 80 characters', () => {
    const { engine } = setup()
    const cases: Array<[string, string]> = [
      ['#a b', 'channel.whitespace'],
      ['#a\tb', 'channel.control_character'],
      ['#a\u2029b', 'channel.line_separator'],
      ['#a\u202db', 'channel.bidi_format'],
      ['#a\u2060b', 'channel.format_character'],
      ['#'.padEnd(HOOK_CHANNEL_MAX_CHARS + 1, 'c'), 'channel.too_long'],
    ]
    for (const [channel, rule] of cases) expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('team-slack', channel) })))), rule).toEqual([rule])
  })

  it('has the same channel grammar as the notify.slack node', () => {
    expect(HOOK_CHANNEL_MAX_CHARS).toBe(SLACK_CHANNEL_MAX)
    const { engine } = setup()
    const samples = ['#alerts', 'C0123ABCDEF', '#a b', '#a\tb', 'x'.repeat(80), 'x'.repeat(81), '\u{1f600}'.repeat(40), '\u{1f600}'.repeat(41), '#a\u00a0b', '#a\ud800']
    for (const sample of samples) {
      const accepted = (() => {
        try {
          engine.saveHook(hookInput({ event: 'plan.deployed', action: notify('team-slack', sample) }))
          return true
        } catch (error) {
          if (error instanceof HookInvalidError) return false
          throw error
        } finally {
          for (const hook of engine.listHooks()) engine.deleteHook(hook.id)
        }
      })()
      expect(accepted, JSON.stringify(sample)).toBe(isSlackChannel(sample))
    }
  })

  it('limits the count of a deactivation to 2 to 20', () => {
    const { engine } = setup()
    for (const count of [-1, 0, 1, 21, 5000]) {
      expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count } })))), String(count)).toEqual(['count.out_of_range'])
    }
    for (const count of [2, 3, 19, 20]) {
      const hook = engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count } }))
      expect(hook.action).toEqual({ type: 'deactivateAfterFailures', count })
      engine.deleteHook(hook.id)
    }
  })

  it('lets a deactivation hook exist only for the event run.failed', () => {
    const { engine } = setup()
    for (const event of ['run.succeeded', 'plan.deployed'] as const) {
      expect(rules(problemsOf(() => engine.saveHook(hookInput({ event, action: { type: 'deactivateAfterFailures', count: 3 } }))))).toEqual(['action.only_for_run_failed'])
    }
    expect(engine.saveHook(hookInput({ event: 'run.failed', action: { type: 'deactivateAfterFailures', count: 3 } })).event).toBe('run.failed')
  })

  it('reports every problem of one save together', () => {
    const { engine } = setup()
    const problems = problemsOf(() => engine.saveHook(hookInput({ event: 'plan.deployed', scope: { type: 'workflow', workflowId: 'missing' }, action: notify('nobody', '#a b') })))
    expect(rules(problems).sort()).toEqual(['channel.whitespace', 'connection.unknown_connection', 'scope.unknown_workflow'])
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ event: 'run.succeeded', action: { type: 'deactivateAfterFailures', count: 1 } }))))).toEqual(['count.out_of_range', 'action.only_for_run_failed'])
  })

  it('gives problems that say what is wrong without the values that were sent', () => {
    const { engine } = setup()
    const marker = 'HOOK-MARKER-2f7c'
    try {
      engine.saveHook(hookInput({ scope: { type: 'workflow', workflowId: marker }, action: notify(`${marker}\n`, `${marker} x`) }))
    } catch (error) {
      expect(error).toBeInstanceOf(HookInvalidError)
      const failure = error as HookInvalidError
      expect(failure.problems.length).toBeGreaterThan(0)
      expect(failure.problems.join('\n')).not.toContain(marker)
      expect(failure.message).not.toContain(marker)
      return
    }
    throw new Error('expected the hook to be refused')
  })
})

describe('hooks and the rules of Plan 10', () => {
  it('refuses a notify hook while a rule forbids notify.slack, and only a notify hook', () => {
    const { engine } = setup()
    const rule = engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' })
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('team-slack') }))))).toEqual(['action.forbidden_by_rule'])
    expect(engine.saveHook(hookInput({ action: { type: 'record' } })).action.type).toBe('record')
    expect(engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } })).action.type).toBe('deactivateAfterFailures')
    engine.deleteRule(rule.id)
    expect(engine.saveHook(hookInput({ event: 'plan.deployed', action: notify('team-slack') })).action.type).toBe('notify')
  })

  it('is not stopped by a rule about another node, an allowed host or an effort cap', () => {
    const { engine } = setup()
    engine.saveRule({ kind: 'forbidNode', value: 'http.request' })
    engine.saveRule({ kind: 'allowHost', value: 'api.example.com' })
    engine.saveRule({ kind: 'maxPlanEffort', value: 'low' })
    expect(engine.saveHook(hookInput({ action: notify('team-slack') })).action.type).toBe('notify')
  })

  it('lets the user switch a notify hook off while a rule forbids notify.slack or its connection is gone, and checks it again when it is switched on', () => {
    const { engine, table } = setup()
    const hook = engine.saveHook(hookInput({ action: notify('team-slack', '#a') }))
    const rule = engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' })
    const off = engine.saveHook({ ...hookInput({ action: notify('team-slack', '#a') }), id: hook.id, enabled: false })
    expect(off).toMatchObject({ id: hook.id, enabled: false })
    expect(rules(problemsOf(() => engine.saveHook({ ...hookInput({ action: notify('team-slack', '#a') }), id: hook.id })))).toEqual(['action.forbidden_by_rule'])
    engine.deleteRule(rule.id)
    table.remove('team-slack')
    expect(rules(problemsOf(() => engine.saveHook({ ...hookInput({ action: notify('team-slack', '#a') }), id: hook.id })))).toEqual(['connection.unknown_connection'])
    expect(engine.saveHook({ ...hookInput({ action: notify('team-slack', '#a') }), id: hook.id, enabled: false }).enabled).toBe(false)
    expect(engine.listHooks()).toHaveLength(1)
  })

  it('reports the rule together with the other problems', () => {
    const { engine } = setup()
    engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' })
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('nobody') })))).sort()).toEqual(['action.forbidden_by_rule', 'connection.unknown_connection'])
  })
})

describe('duplicates and the limit of 20', () => {
  it('refuses a second hook with the same event, scope and action, and says so as a problem', () => {
    const { engine } = setup()
    engine.saveHook(hookInput({ action: notify('team-slack', '#a') }))
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('team-slack', '  #a ') }))))).toEqual(['hook.duplicate'])
    expect(rules(problemsOf(() => engine.saveHook(hookInput({ action: notify('team-slack', '#a'), enabled: false }))))).toEqual(['hook.duplicate'])
    expect(engine.listHooks()).toHaveLength(1)
  })

  it('allows hooks that differ in the event, the scope, the connection, the channel or the count', () => {
    const { engine } = setup()
    const workflowId = engine.deploy(echoWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack', '#a') }))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack', '#a') }))
    engine.saveHook(hookInput({ scope: { type: 'workflow', workflowId }, action: notify('team-slack', '#a') }))
    engine.saveHook(hookInput({ action: notify('hook-slack') }))
    engine.saveHook(hookInput({ action: notify('team-slack', '#b') }))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 3 } }))
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 4 } }))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    engine.saveHook(hookInput({ event: 'plan.deployed', action: { type: 'record' } }))
    expect(engine.listHooks()).toHaveLength(10)
  })

  it('does not call a hook a duplicate of itself, but of another one', () => {
    const { engine } = setup()
    const one = engine.saveHook(hookInput({ action: { type: 'record' } }))
    const two = engine.saveHook(hookInput({ event: 'run.succeeded', action: { type: 'record' } }))
    expect(engine.saveHook({ ...hookInput({ action: { type: 'record' } }), id: one.id }).id).toBe(one.id)
    expect(engine.saveHook({ ...hookInput({ action: { type: 'record' }, enabled: false }), id: one.id }).enabled).toBe(false)
    expect(rules(problemsOf(() => engine.saveHook({ ...hookInput({ event: 'run.failed', action: { type: 'record' } }), id: two.id })))).toEqual(['hook.duplicate'])
  })

  it('refuses the 21st hook with HookFullError, still lets a full list be edited, and frees a place when one is deleted', () => {
    const { engine } = setup()
    const saved = Array.from({ length: HOOK_MAX_ITEMS }, (_, index) => engine.saveHook(hookInput({ action: notify('team-slack', `#c${index}`) })))
    expect(engine.listHooks()).toHaveLength(HOOK_MAX_ITEMS)
    expect(() => engine.saveHook(hookInput({ action: notify('team-slack', '#one-too-many') }))).toThrow(HookFullError)
    expect(engine.saveHook({ ...hookInput({ action: notify('team-slack', '#edited') }), id: saved[0]!.id }).id).toBe(saved[0]!.id)
    expect(engine.deleteHook(saved[1]!.id)).toBe(true)
    expect(engine.saveHook(hookInput({ action: notify('team-slack', '#fits-now') })).action).toMatchObject({ channel: '#fits-now' })
    expect(engine.listHooks()).toHaveLength(HOOK_MAX_ITEMS)
  })
})

describe('Engine.deleteHook', () => {
  it('says whether a hook was deleted', () => {
    const { engine } = setup()
    const hook = engine.saveHook(hookInput())
    expect(engine.deleteHook(hook.id)).toBe(true)
    expect(engine.deleteHook(hook.id)).toBe(false)
    expect(engine.deleteHook('missing')).toBe(false)
    expect(engine.listHooks()).toEqual([])
  })
})

describe('deleting a workflow deletes its hooks', () => {
  it('removes the hooks of that workflow only, keeps their log rows and tells the cache', () => {
    const { engine, db } = setup()
    const doomed = engine.deploy(echoWorkflow('doomed'))
    const kept = engine.deploy(echoWorkflow('kept'))
    const own = engine.saveHook(hookInput({ scope: { type: 'workflow', workflowId: doomed } }))
    const other = engine.saveHook(hookInput({ event: 'run.succeeded', scope: { type: 'workflow', workflowId: kept } }))
    const everywhere = engine.saveHook(hookInput({ event: 'plan.deployed' }))
    engine.store.appendHookLog({ hookId: own.id, at: 5, event: 'run.failed', workflowId: doomed, outcome: 'ok', code: null })
    const before = engine.store.hooksRevision
    engine.deleteWorkflow(doomed)
    expect(engine.listHooks().map((hook) => hook.id)).toEqual([other.id, everywhere.id])
    expect(db.all('SELECT hook_id FROM hook_log')).toEqual([{ hook_id: own.id }])
    expect(engine.store.hooksRevision).toBeGreaterThan(before)
    expect(db.get('SELECT 1 AS found FROM workflows WHERE id = ?', doomed)).toBeUndefined()
  })

  it('leaves the revision alone when the workflow had no hook', () => {
    const { engine } = setup()
    const id = engine.deploy(echoWorkflow('plain'))
    engine.saveHook(hookInput())
    const before = engine.store.hooksRevision
    engine.deleteWorkflow(id)
    expect(engine.store.hooksRevision).toBe(before)
  })
})

describe('the revision of the hooks', () => {
  it('moves with every change of a hook and stays when a save is refused', () => {
    const { engine } = setup()
    const start = engine.store.hooksRevision
    const hook = engine.saveHook(hookInput())
    expect(engine.store.hooksRevision).toBeGreaterThan(start)
    const afterSave = engine.store.hooksRevision
    expect(() => engine.saveHook(hookInput())).toThrow(HookInvalidError)
    expect(() => engine.saveHook({ ...hookInput(), id: 'missing' })).toThrow(HookNotFoundError)
    expect(engine.store.hooksRevision).toBe(afterSave)
    engine.saveHook({ ...hookInput({ enabled: false }), id: hook.id })
    expect(engine.store.hooksRevision).toBeGreaterThan(afterSave)
    const afterEdit = engine.store.hooksRevision
    engine.deleteHook('missing')
    expect(engine.store.hooksRevision).toBe(afterEdit)
    engine.deleteHook(hook.id)
    expect(engine.store.hooksRevision).toBeGreaterThan(afterEdit)
  })
})

describe('the hook log', () => {
  const row = (hookId: string, at: number, overrides: Partial<Parameters<Engine['store']['appendHookLog']>[0]> = {}) =>
    ({ hookId, at, event: 'run.failed', workflowId: 'wf', outcome: 'ok', code: null, ...overrides }) as Parameters<Engine['store']['appendHookLog']>[0]

  it('lists the newest row first and the rows pass the protocol schema', () => {
    const { engine } = setup()
    engine.store.appendHookLog(row('h1', 10))
    engine.store.appendHookLog(row('h1', 20, { outcome: 'failed', code: 'timeout' }))
    engine.store.appendHookLog(row('h2', 30, { outcome: 'skipped_cooldown', event: 'plan.deployed' }))
    const entries = engine.listHookLog({})
    expect(entries.map((entry) => entry.at)).toEqual([30, 20, 10])
    expect(entries[1]).toMatchObject({ hookId: 'h1', outcome: 'failed', code: 'timeout', event: 'run.failed', workflowId: 'wf' })
    for (const entry of entries) expect(Value.Check(HookLogEntrySchema, entry)).toBe(true)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(3)
  })

  it('orders by insertion when two rows have the same time', () => {
    const { engine } = setup()
    engine.store.appendHookLog(row('h1', 10, { workflowId: 'first' }))
    engine.store.appendHookLog(row('h1', 10, { workflowId: 'second' }))
    expect(engine.listHookLog({}).map((entry) => entry.workflowId)).toEqual(['second', 'first'])
  })

  it('filters by hook and limits the count: 50 by default, 1 to 200', () => {
    const { engine } = setup()
    for (let index = 0; index < 260; index++) engine.store.appendHookLog(row(index % 2 === 0 ? 'even' : 'odd', index))
    expect(engine.listHookLog({})).toHaveLength(50)
    expect(engine.listHookLog({ limit: 7 })).toHaveLength(7)
    expect(engine.listHookLog({ limit: 200 })).toHaveLength(200)
    expect(engine.listHookLog({ limit: 100_000 })).toHaveLength(200)
    expect(engine.listHookLog({ limit: 0 })).toHaveLength(1)
    expect(engine.listHookLog({ limit: -5 })).toHaveLength(1)
    expect(engine.listHookLog({ limit: Number.NaN })).toHaveLength(50)
    const even = engine.listHookLog({ hookId: 'even', limit: 200 })
    expect(even).toHaveLength(130)
    expect(even.every((entry) => entry.hookId === 'even')).toBe(true)
    expect(engine.listHookLog({ hookId: 'nobody' })).toEqual([])
  })

  it('keeps the newest 500 rows and drops the oldest on insert', () => {
    const { engine, db } = setup()
    for (let index = 1; index <= 520; index++) engine.store.appendHookLog(row('h', index))
    const times = db.all<{ at: number }>('SELECT at FROM hook_log ORDER BY id').map((entry) => entry.at)
    expect(times).toHaveLength(500)
    expect(times[0]).toBe(21)
    expect(times[499]).toBe(520)
    for (let index = 521; index <= 530; index++) engine.store.appendHookLog(row('h', index))
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM hook_log')?.n).toBe(500)
    expect(engine.listHookLog({ limit: 1 })[0]!.at).toBe(530)
  })

  it('keeps counting ids upward after a prune', () => {
    const { engine } = setup()
    for (let index = 1; index <= 505; index++) engine.store.appendHookLog(row('h', index))
    const newest = engine.listHookLog({ limit: 1 })[0]!
    engine.store.appendHookLog(row('h', 999))
    expect(engine.listHookLog({ limit: 1 })[0]!.id).toBeGreaterThan(newest.id)
  })

  it('keeps the rows of a hook that is deleted, so that the screen can call them a deleted hook', () => {
    const { engine } = setup()
    const hook = engine.saveHook(hookInput())
    engine.store.appendHookLog(row(hook.id, 10))
    engine.deleteHook(hook.id)
    expect(engine.listHookLog({ hookId: hook.id })).toHaveLength(1)
  })

  it('holds only fixed codes and outcomes, as the table says', () => {
    const { engine, db } = setup()
    expect(() => engine.store.appendHookLog(row('h', 1, { outcome: 'failed', code: 'Slack said channel_not_found' as never }))).toThrow()
    expect(() => engine.store.appendHookLog(row('h', 1, { outcome: 'sent' as never }))).toThrow()
    expect(() => engine.store.appendHookLog(row('h', 1, { event: 'run.started' as never }))).toThrow()
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM hook_log')?.n).toBe(0)
  })
})

describe('the hooks table', () => {
  it('rejects rows the engine would never write', () => {
    const { db } = setup()
    const insert = (columns: string) => db.exec(`INSERT INTO hooks (id, event, scope_workflow_id, action_type, connection, channel, failure_count, enabled, dedupe_key, created_at, updated_at) VALUES ${columns}`)
    expect(() => insert("('a', 'run.failed', NULL, 'record', NULL, NULL, NULL, 1, 'k1', 1, 1)")).not.toThrow()
    expect(() => insert("('b', 'run.started', NULL, 'record', NULL, NULL, NULL, 1, 'k2', 1, 1)")).toThrow()
    expect(() => insert("('c', 'run.failed', NULL, 'startRun', NULL, NULL, NULL, 1, 'k3', 1, 1)")).toThrow()
    expect(() => insert("('d', 'run.failed', NULL, 'notify', NULL, NULL, NULL, 1, 'k4', 1, 1)")).toThrow()
    expect(() => insert("('e', 'run.failed', NULL, 'deactivateAfterFailures', NULL, NULL, 1, 1, 'k5', 1, 1)")).toThrow()
    expect(() => insert("('f', 'run.succeeded', NULL, 'deactivateAfterFailures', NULL, NULL, 3, 1, 'k6', 1, 1)")).toThrow()
    expect(() => insert("('g', 'run.failed', 'no-such-workflow', 'record', NULL, NULL, NULL, 1, 'k7', 1, 1)")).toThrow()
    expect(() => insert("('h', 'run.failed', NULL, 'record', NULL, NULL, NULL, 2, 'k8', 1, 1)")).toThrow()
    expect(() => insert("('i', 'run.failed', NULL, 'record', NULL, NULL, NULL, 1, 'k1', 1, 1)")).toThrow()
  })
})

const HOOK_EVENTS_FOR_TEST: HookInput['event'][] = ['run.failed', 'run.succeeded', 'plan.deployed']
