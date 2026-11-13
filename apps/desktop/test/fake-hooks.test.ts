import { HOOK_LOG_MAX_ROWS, HOOK_MAX_ITEMS, RillError, type Hook, type HookInput, type HookLogEntry } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods, type FakePlanData } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

const workflowId = fakeData.workflows[0]!.id
const otherId = fakeData.workflows[1]!.id

const record: HookInput = { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true }
const notify = (connection: string, channel?: string): HookInput => ({ ...record, action: { type: 'notify', connection, ...(channel === undefined ? {} : { channel }) } })

function make(extra: Partial<FakePlanData> = {}) {
  let tick = 1000
  const data: FakePlanData = {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    connections: [
      { name: 'team-slack', kind: 'slack' },
      { name: 'api', kind: 'http' },
    ],
    now: () => (tick += 10),
    ...extra,
  }
  const base = createFakeClient(fakeData)
  const client = withPlanMethods(base, data)
  return { client, base, request: client.request.bind(client) as typeof client.request }
}

async function failure(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

const lines = (error: RillError) => (error.problems ?? []).map((line) => line.split(':')[0])

describe('the fake engine answers the hook methods with the rules of the engine', () => {
  it('starts with no hooks, saves one under a new id and lists it', async () => {
    const { request } = make()
    expect(await request('listHooks', {})).toEqual({ hooks: [] })
    const hook = (await request('saveHook', record)).hook
    expect(hook).toMatchObject({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    expect(hook.createdAt).toBe(hook.updatedAt)
    expect((await request('listHooks', {})).hooks).toEqual([hook])
  })

  it('can start with saved hooks and log rows', async () => {
    const seeded: Hook = { id: 'h-1', event: 'plan.deployed', scope: { type: 'all' }, action: { type: 'record' }, enabled: false, createdAt: 1, updatedAt: 1 }
    const row: HookLogEntry = { id: 4, hookId: 'h-1', at: 9, event: 'plan.deployed', workflowId, outcome: 'ok', code: null }
    const { request } = make({ hooks: [seeded], hookLog: [row] })
    expect((await request('listHooks', {})).hooks).toEqual([seeded])
    expect((await request('listHookLog', {})).entries).toEqual([row])
  })

  it('edits in place and keeps the order of creation', async () => {
    const { request } = make()
    const first = (await request('saveHook', record)).hook
    const second = (await request('saveHook', { ...record, event: 'run.succeeded' })).hook
    const edited = (await request('saveHook', { ...record, enabled: false, id: first.id })).hook
    expect(edited).toMatchObject({ id: first.id, createdAt: first.createdAt, enabled: false })
    expect(edited.updatedAt).toBeGreaterThan(first.updatedAt)
    expect((await request('listHooks', {})).hooks.map((hook) => hook.id)).toEqual([first.id, second.id])
  })

  it('deletes and says whether it did', async () => {
    const { request } = make()
    const hook = (await request('saveHook', record)).hook
    expect(await request('deleteHook', { id: hook.id })).toEqual({ deleted: true })
    expect(await request('deleteHook', { id: hook.id })).toEqual({ deleted: false })
  })

  it('checks a workflow scope against the workflows that the fake engine has', async () => {
    const { request } = make()
    expect((await request('saveHook', { ...record, scope: { type: 'workflow', workflowId } })).hook.scope).toEqual({ type: 'workflow', workflowId })
    const error = await failure(request('saveHook', { ...record, scope: { type: 'workflow', workflowId: 'missing' } }))
    expect(error.code).toBe('HOOK_INVALID')
    expect(lines(error)).toEqual(['scope.unknown_workflow'])
  })

  it('checks the connection against the saved connections and their kinds', async () => {
    const { request } = make()
    expect((await request('saveHook', notify('team-slack', ' #ops '))).hook.action).toEqual({ type: 'notify', connection: 'team-slack', channel: '#ops' })
    expect(lines(await failure(request('saveHook', notify('api'))))).toEqual(['connection.not_slack_connection'])
    expect(lines(await failure(request('saveHook', notify('nobody'))))).toEqual(['connection.unknown_connection'])
    expect(lines(await failure(request('saveHook', notify(''))))).toEqual(['connection.empty'])
    expect(lines(await failure(request('saveHook', notify('team-slack', 'a b'))))).toEqual(['channel.whitespace'])
  })

  it('has no connection at all unless the fake engine is given some', async () => {
    const { request } = make({ connections: undefined })
    expect(lines(await failure(request('saveHook', notify('team-slack'))))).toEqual(['connection.unknown_connection'])
  })

  it('refuses a notify hook while a rule forbids notify.slack, and allows it again after the rule goes', async () => {
    const { request } = make()
    const rule = (await request('saveRule', { kind: 'forbidNode', value: 'notify.slack' })).rule
    const error = await failure(request('saveHook', notify('team-slack')))
    expect(error.code).toBe('HOOK_INVALID')
    expect(lines(error)).toEqual(['action.forbidden_by_rule'])
    expect((await request('saveHook', record)).hook.action.type).toBe('record')
    await request('deleteRule', { id: rule.id })
    expect((await request('saveHook', notify('team-slack'))).hook.action.type).toBe('notify')
  })

  it('checks the count and the event of a deactivation', async () => {
    const { request } = make()
    for (const count of [1, 21]) expect(lines(await failure(request('saveHook', { ...record, action: { type: 'deactivateAfterFailures', count } }))), String(count)).toEqual(['count.out_of_range'])
    expect(lines(await failure(request('saveHook', { ...record, event: 'run.succeeded', action: { type: 'deactivateAfterFailures', count: 3 } })))).toEqual(['action.only_for_run_failed'])
    expect((await request('saveHook', { ...record, action: { type: 'deactivateAfterFailures', count: 3 } })).hook.action).toEqual({ type: 'deactivateAfterFailures', count: 3 })
  })

  it('refuses a duplicate, the 21st hook and an unknown id, and still edits when full', async () => {
    const { request } = make()
    await request('saveHook', record)
    const duplicate = await failure(request('saveHook', { ...record, enabled: false }))
    expect(duplicate.code).toBe('HOOK_INVALID')
    expect(lines(duplicate)).toEqual(['hook.duplicate'])
    expect((await failure(request('saveHook', { ...record, id: 'missing' }))).code).toBe('HOOK_NOT_FOUND')
    const saved: Hook[] = []
    for (let index = 1; index < HOOK_MAX_ITEMS; index++) saved.push((await request('saveHook', notify('team-slack', `#c${index}`))).hook)
    expect((await failure(request('saveHook', notify('team-slack', '#one-too-many')))).code).toBe('HOOK_FULL')
    expect((await request('saveHook', { ...notify('team-slack', '#edited'), id: saved[0]!.id })).hook.id).toBe(saved[0]!.id)
  })

  it('checks the params with the protocol schema', async () => {
    const { request } = make()
    expect((await failure(request('saveHook', { ...record, extra: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(request('saveHook', { ...record, action: { type: 'startRun' } } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(request('listHookLog', { limit: 0 }))).code).toBe('INVALID_PARAMS')
  })

  it('deletes the hooks of a workflow that is deleted, and keeps the others and the log', async () => {
    const { client, request } = make()
    const own = (await request('saveHook', { ...record, scope: { type: 'workflow', workflowId } })).hook
    const other = (await request('saveHook', { ...record, event: 'run.succeeded', scope: { type: 'workflow', workflowId: otherId } })).hook
    const everywhere = (await request('saveHook', { ...record, event: 'plan.deployed' })).hook
    client.hooks.addLog({ hookId: own.id, at: 5, event: 'run.failed', workflowId, outcome: 'ok', code: null })
    await request('deleteWorkflow', { workflowId })
    expect((await request('listHooks', {})).hooks.map((hook) => hook.id)).toEqual([other.id, everywhere.id])
    expect((await request('listHookLog', {})).entries).toHaveLength(1)
  })
})

describe('the fake hook log', () => {
  const entry = (at: number, overrides: Partial<Omit<HookLogEntry, 'id'>> = {}): Omit<HookLogEntry, 'id'> => ({ hookId: 'h', at, event: 'run.failed', workflowId, outcome: 'ok', code: null, ...overrides })

  it('lets a test add a row and gives it the next id, newest first', async () => {
    const { client, request } = make()
    const first = client.hooks.addLog(entry(10))
    const second = client.hooks.addLog(entry(20, { outcome: 'failed', code: 'timeout' }))
    expect(second.id).toBeGreaterThan(first.id)
    expect((await request('listHookLog', {})).entries).toEqual([second, first])
  })

  it('filters by hook and limits the count like the engine: 50 by default, 1 to 200', async () => {
    const { client, request } = make()
    for (let index = 0; index < 260; index++) client.hooks.addLog(entry(index, { hookId: index % 2 === 0 ? 'even' : 'odd' }))
    expect((await request('listHookLog', {})).entries).toHaveLength(50)
    expect((await request('listHookLog', { limit: 7 })).entries).toHaveLength(7)
    expect((await request('listHookLog', { limit: 200 })).entries).toHaveLength(200)
    const even = (await request('listHookLog', { hookId: 'even', limit: 200 })).entries
    expect(even).toHaveLength(130)
    expect(even.every((row) => row.hookId === 'even')).toBe(true)
  })

  it('keeps the newest 500 rows', async () => {
    const { client, request } = make()
    for (let index = 1; index <= HOOK_LOG_MAX_ROWS + 20; index++) client.hooks.addLog(entry(index))
    const rows = (await request('listHookLog', { limit: 200 })).entries
    expect(rows[0]!.at).toBe(HOOK_LOG_MAX_ROWS + 20)
    client.hooks.addLog(entry(9999))
    expect(client.hooks.size()).toBe(HOOK_LOG_MAX_ROWS)
  })

  it('keeps the rows of a deleted hook', async () => {
    const { client, request } = make()
    const hook = (await request('saveHook', record)).hook
    client.hooks.addLog(entry(1, { hookId: hook.id }))
    await request('deleteHook', { id: hook.id })
    expect((await request('listHookLog', { hookId: hook.id })).entries).toHaveLength(1)
  })
})

describe('the fake client passes the other methods through', () => {
  it('still answers listWorkflows', async () => {
    const { request } = make()
    expect((await request('listWorkflows', {})).workflows.length).toBe(fakeData.workflows.length)
  })
})
