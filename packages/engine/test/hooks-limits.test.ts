import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_COOLDOWN_MS, HOOK_RATE_LIMIT, HOOK_RATE_WINDOW_MS } from '@rill/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { failingWorkflow, hookInput, notify, openEngine, stubSlack, textOf } from './hook-helpers'
import { START, finished, finishedRun, logRows, outcomes, standalone, workflowIn } from './hook-runner-helpers'
import { ManualClock } from './manual-clock'

const engines: Engine[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const engine of engines.splice(0)) await engine.shutdown()
})

const NOTIFY = { event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack' }, enabled: true } as const
const RECORD = { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true } as const

function failing() {
  const context = standalone()
  const workflowId = workflowIn(context.store, 'w')
  const runId = finishedRun(context.store, workflowId, 'failed')
  const fire = async (at: number) => {
    context.runner.handle(finished(runId, 'failed', at))
    await context.runner.idle()
  }
  return { ...context, workflowId, runId, fire }
}

describe('the cooldown of a notify hook', () => {
  it('lets the first event post and skips a second one inside 60 seconds, without a post', async () => {
    const calls = stubSlack()
    const { store, db, fire } = failing()
    store.saveHook(NOTIFY)
    await fire(START)
    await fire(START + 1000)
    await fire(START + 30_000)
    expect(calls).toHaveLength(1)
    expect(outcomes(db)).toEqual(['ok', 'skipped_cooldown', 'skipped_cooldown'])
  })

  it('counts the cooldown from the last post and not from a skipped event, with the edge at exactly 60 seconds', async () => {
    expect(HOOK_COOLDOWN_MS).toBe(60_000)
    const calls = stubSlack()
    const { store, db, fire } = failing()
    store.saveHook(NOTIFY)
    await fire(START)
    await fire(START + HOOK_COOLDOWN_MS - 1)
    expect(calls).toHaveLength(1)
    await fire(START + HOOK_COOLDOWN_MS)
    expect(calls).toHaveLength(2)
    await fire(START + HOOK_COOLDOWN_MS + 59_999)
    expect(calls).toHaveLength(2)
    await fire(START + 2 * HOOK_COOLDOWN_MS)
    expect(calls).toHaveLength(3)
    expect(outcomes(db)).toEqual(['ok', 'skipped_cooldown', 'ok', 'skipped_cooldown', 'ok'])
  })

  it('belongs to one hook: another hook still posts, and a hook of another event is not held back', async () => {
    const calls = stubSlack()
    const { store, db, fire, runner, workflowId } = failing()
    const one = store.saveHook({ ...NOTIFY, action: { type: 'notify', connection: 'team-slack', channel: '#one' } })
    await fire(START)
    const two = store.saveHook({ ...NOTIFY, action: { type: 'notify', connection: 'team-slack', channel: '#two' } })
    await fire(START + 1000)
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['#one', '#two'])
    expect(logRows(db).map((row) => [row.hook_id, row.outcome])).toEqual([
      [one.id, 'ok'],
      [one.id, 'skipped_cooldown'],
      [two.id, 'ok'],
    ])
    store.saveHook({ event: 'plan.deployed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#deploy' }, enabled: true })
    runner.handle({ type: 'plan.deployed', at: START + 2000, workflowId, planId: 'p' })
    await runner.idle()
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['#one', '#two', '#deploy'])
  })

  it('is shared by every workflow that a hook with the scope all covers, and says so with a skipped row for the second workflow', async () => {
    const calls = stubSlack()
    const { store, db, runner } = standalone()
    const one = workflowIn(store, 'one')
    const two = workflowIn(store, 'two')
    store.saveHook(NOTIFY)
    runner.handle(finished(finishedRun(store, one, 'failed'), 'failed', START))
    runner.handle(finished(finishedRun(store, two, 'failed'), 'failed', START + 5))
    await runner.idle()
    expect(calls.map(textOf)).toEqual(['Workflow "one" failed.'])
    expect(logRows(db).map((row) => [row.workflow_id, row.outcome])).toEqual([
      [one, 'ok'],
      [two, 'skipped_cooldown'],
    ])
  })

  it('starts after a failed attempt too, so that a broken Slack is not hammered', async () => {
    const calls = stubSlack(() => new Response('x', { status: 500 }))
    const { store, db, fire } = failing()
    store.saveHook(NOTIFY)
    await fire(START)
    await fire(START + 5000)
    expect(calls).toHaveLength(1)
    expect(outcomes(db)).toEqual(['failed:http_status', 'skipped_cooldown'])
  })

  it('is not started by a hook that was skipped, blocked or rate limited', async () => {
    const calls = stubSlack()
    const forbidden: string[] = ['notify.slack']
    const { store, db, fire } = (() => {
      const context = standalone({ forbidden: () => forbidden })
      const workflowId = workflowIn(context.store, 'w')
      const runId = finishedRun(context.store, workflowId, 'failed')
      return {
        ...context,
        fire: async (at: number) => {
          context.runner.handle(finished(runId, 'failed', at))
          await context.runner.idle()
        },
      }
    })()
    store.saveHook(NOTIFY)
    await fire(START)
    forbidden.length = 0
    await fire(START + 1)
    expect(calls).toHaveLength(1)
    expect(outcomes(db)).toEqual(['blocked_by_rule', 'ok'])
  })

  it('does not apply to a record hook or to a deactivation hook', async () => {
    const { store, db, fire } = failing()
    store.saveHook(RECORD)
    store.saveHook({ ...RECORD, action: { type: 'deactivateAfterFailures', count: 2 } })
    for (let index = 0; index < 4; index++) await fire(START + index)
    expect(outcomes(db).filter((outcome) => outcome === 'skipped_cooldown')).toEqual([])
    expect(outcomes(db).filter((outcome) => outcome === 'ok')).toHaveLength(4)
  })

  it('survives a restart, because it is read from the log', async () => {
    const calls = stubSlack()
    const dir = mkdtempSync(join(tmpdir(), 'rill-hooks-cooldown-'))
    try {
      const file = join(dir, 'rill.db')
      const firstDb = Db.open(file)
      const first = openEngine({ db: firstDb, clock: new ManualClock(START) })
      const workflowId = first.engine.deploy(failingWorkflow('w'))
      first.engine.saveHook(hookInput({ action: notify('team-slack') }))
      await first.engine.startRun(workflowId, {})
      await first.engine.idle()
      await first.engine.shutdown()
      firstDb.close()
      expect(calls).toHaveLength(1)

      const secondDb = Db.open(file)
      const clock = new ManualClock(START + 20_000)
      const second = openEngine({ db: secondDb, clock })
      engines.push(second.engine)
      await second.engine.startRun(workflowId, {})
      await second.engine.idle()
      expect(calls).toHaveLength(1)
      clock.jump(60_000)
      await second.engine.startRun(workflowId, {})
      await second.engine.idle()
      expect(calls).toHaveLength(2)
      expect(outcomes(secondDb)).toEqual(['ok', 'skipped_cooldown', 'ok'])
      await second.engine.shutdown()
      engines.length = 0
      secondDb.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the global cap of 30 executed actions per 10 minutes', () => {
  it('is 30 per 10 minutes', () => {
    expect(HOOK_RATE_LIMIT).toBe(30)
    expect(HOOK_RATE_WINDOW_MS).toBe(600_000)
  })

  it('lets 30 actions run and writes the next ones as rate_limited, without doing them', async () => {
    const calls = stubSlack()
    const { store, db, fire } = failing()
    store.saveHook(RECORD)
    for (let index = 0; index < 35; index++) await fire(START + index)
    const all = outcomes(db)
    expect(all.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 'ok'))
    expect(all.slice(30)).toEqual(Array.from({ length: 5 }, () => 'rate_limited'))
    expect(calls).toHaveLength(0)
  })

  it('does not post for a notify hook that is rate limited', async () => {
    const calls = stubSlack()
    const { store, db, fire } = failing()
    store.saveHook(RECORD)
    for (let index = 0; index < 30; index++) await fire(START + index)
    store.saveHook(NOTIFY)
    await fire(START + 100)
    expect(calls).toHaveLength(0)
    expect(outcomes(db).slice(-2)).toEqual(['rate_limited', 'rate_limited'])
  })

  it('counts every kind of hook together, and a failed attempt as well as a done one', async () => {
    stubSlack((call) => (String(JSON.parse(call.body).channel).startsWith('#bad') ? new Response('x', { status: 500 }) : new Response('{"ok":true}', { status: 200 })))
    const { store, db, fire } = failing()
    store.saveHook(RECORD)
    store.saveHook({ ...NOTIFY, action: { type: 'notify', connection: 'team-slack', channel: '#bad1' } })
    store.saveHook({ ...NOTIFY, action: { type: 'notify', connection: 'team-slack', channel: '#bad2' } })
    for (let index = 0; index < 10; index++) await fire(START + index * HOOK_COOLDOWN_MS)
    const executed = outcomes(db).filter((outcome) => outcome === 'ok' || outcome.startsWith('failed'))
    expect(executed).toHaveLength(HOOK_RATE_LIMIT)
    expect(outcomes(db).filter((outcome) => outcome === 'failed:http_status')).toHaveLength(20)
    await fire(START + 570_001)
    expect(outcomes(db).slice(-3)).toEqual(['rate_limited', 'skipped_cooldown', 'skipped_cooldown'])
  })

  it('stops a deactivation too, so that the workflow stays active until the window has passed', async () => {
    const { store, db, runner, fire, workflowId, deactivated } = failing()
    store.saveHook(RECORD)
    for (let index = 0; index < 30; index++) await fire(START + index)
    const second = finishedRun(store, workflowId, 'failed')
    store.setWorkflowActive(workflowId, true)
    store.saveHook({ ...RECORD, action: { type: 'deactivateAfterFailures', count: 2 } })
    runner.handle(finished(second, 'failed', START + 100))
    await runner.idle()
    expect(deactivated).toEqual([])
    expect(outcomes(db).slice(-2)).toEqual(['rate_limited', 'rate_limited'])
    expect(store.isWorkflowActive(workflowId)).toBe(true)
    runner.handle(finished(second, 'failed', START + HOOK_RATE_WINDOW_MS + 100))
    await runner.idle()
    expect(deactivated).toEqual([workflowId])
    expect(outcomes(db).slice(-2)).toEqual(['ok', 'ok'])
  })

  it('does not count skipped, blocked or rate limited rows', async () => {
    const calls = stubSlack()
    const { store, db, fire } = failing()
    store.saveHook(NOTIFY)
    for (let index = 0; index < 100; index++) await fire(START + index)
    expect(outcomes(db).filter((outcome) => outcome === 'ok')).toHaveLength(1)
    expect(outcomes(db).filter((outcome) => outcome === 'skipped_cooldown')).toHaveLength(99)
    expect(calls).toHaveLength(1)
    store.saveHook(RECORD)
    for (let index = 0; index < 29; index++) await fire(START + 200 + index)
    expect(outcomes(db).filter((outcome) => outcome === 'rate_limited')).toEqual([])
  })

  it('measures the window from the event time, with the oldest action leaving it after exactly 10 minutes', async () => {
    const { store, db, fire } = failing()
    store.saveHook(RECORD)
    for (let index = 0; index < 30; index++) await fire(START + index)
    await fire(START + HOOK_RATE_WINDOW_MS - 1)
    expect(outcomes(db).at(-1)).toBe('rate_limited')
    await fire(START + HOOK_RATE_WINDOW_MS)
    expect(outcomes(db).at(-1)).toBe('ok')
    await fire(START + HOOK_RATE_WINDOW_MS)
    expect(outcomes(db).at(-1)).toBe('rate_limited')
    await fire(START + HOOK_RATE_WINDOW_MS + 1)
    expect(outcomes(db).at(-1)).toBe('ok')
  })

  it('asks the cooldown before the cap, so a hook in its cooldown says so even when the cap is reached', async () => {
    const calls = stubSlack()
    const { store, db, fire } = failing()
    store.saveHook(NOTIFY)
    await fire(START)
    store.saveHook(RECORD)
    for (let index = 0; index < 40; index++) await fire(START + 1 + index)
    const notifyRows = logRows(db).filter((row) => row.outcome === 'skipped_cooldown')
    expect(notifyRows.length).toBeGreaterThan(30)
    expect(calls).toHaveLength(1)
  })

  it('survives a restart, because it is read from the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rill-hooks-cap-'))
    try {
      const file = join(dir, 'rill.db')
      const firstDb = Db.open(file)
      const first = openEngine({ db: firstDb, clock: new ManualClock(START) })
      const workflowId = first.engine.deploy(failingWorkflow('w'))
      first.engine.saveHook(hookInput({ action: { type: 'record' } }))
      for (let index = 0; index < 30; index++) await first.engine.startRun(workflowId, {})
      await first.engine.idle()
      await first.engine.shutdown()
      firstDb.close()

      const secondDb = Db.open(file)
      const second = openEngine({ db: secondDb, clock: new ManualClock(START + 5000) })
      engines.push(second.engine)
      await second.engine.startRun(workflowId, {})
      await second.engine.idle()
      expect(outcomes(secondDb).at(-1)).toBe('rate_limited')
      expect(outcomes(secondDb).filter((outcome) => outcome === 'ok')).toHaveLength(30)
      await second.engine.shutdown()
      engines.length = 0
      secondDb.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
