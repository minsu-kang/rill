import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { HookRunner } from '../src/hooks-runner'
import { echoWorkflow, hookInput, openEngine, stubSlack } from './hook-helpers'
import { START, finished, finishedRun, logRows, outcomes, standalone, workflowIn } from './hook-runner-helpers'
import { ManualClock } from './manual-clock'

const engines: Engine[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function scenario(count: number, options: { active?: boolean; scope?: 'all' | 'workflow' } = {}) {
  const context = standalone()
  const workflowId = workflowIn(context.store, 'w')
  context.store.setWorkflowActive(workflowId, options.active ?? true)
  context.store.saveHook({
    event: 'run.failed',
    scope: options.scope === 'all' ? { type: 'all' } : { type: 'workflow', workflowId },
    action: { type: 'deactivateAfterFailures', count },
    enabled: true,
  })
  let at = START
  const end = async (runId: string, status: 'succeeded' | 'failed') => {
    at += 1000
    context.runner.handle(finished(runId, status, at))
    await context.runner.idle()
  }
  const finish = async (status: 'succeeded' | 'failed', dryRun = false, id = workflowId) => {
    const runId = finishedRun(context.store, id, status, dryRun)
    await end(runId, status)
    return runId
  }
  return { ...context, workflowId, finish, end }
}

describe('deactivateAfterFailures reads the run history', () => {
  it('deactivates on exactly N failures in a row and not on N minus 1', async () => {
    const { finish, db, deactivated, workflowId } = scenario(3)
    await finish('failed')
    await finish('failed')
    expect(deactivated).toEqual([])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'skipped_inactive'])
    await finish('failed')
    expect(deactivated).toEqual([workflowId])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'skipped_inactive', 'ok'])
  })

  it('works for the smallest count of 2 and for the largest count of 20', async () => {
    const small = scenario(2)
    await small.finish('failed')
    await small.finish('failed')
    expect(small.deactivated).toEqual([small.workflowId])
    const large = scenario(20)
    for (let index = 0; index < 19; index++) await large.finish('failed')
    expect(large.deactivated).toEqual([])
    await large.finish('failed')
    expect(large.deactivated).toEqual([large.workflowId])
  })

  it('is reset by a success in between', async () => {
    const { finish, deactivated, workflowId, db } = scenario(2)
    await finish('failed')
    await finish('succeeded')
    await finish('failed')
    expect(deactivated).toEqual([])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'skipped_inactive'])
    await finish('failed')
    expect(deactivated).toEqual([workflowId])
  })

  it('does not count a dry run and is not reset by one', async () => {
    const failed = scenario(2)
    await failed.finish('failed')
    await failed.finish('failed', true)
    await failed.finish('failed', true)
    expect(failed.deactivated).toEqual([])
    await failed.finish('failed')
    expect(failed.deactivated).toEqual([failed.workflowId])
    expect(outcomes(failed.db)).toEqual(['skipped_inactive', 'ok'])

    const succeeded = scenario(2)
    await succeeded.finish('failed')
    await succeeded.finish('succeeded', true)
    await succeeded.finish('failed')
    expect(succeeded.deactivated).toEqual([succeeded.workflowId])
  })

  it('writes skipped_inactive when the workflow is already inactive, and does not deactivate it again', async () => {
    const { finish, deactivated, store, workflowId, db } = scenario(2, { active: false })
    await finish('failed')
    await finish('failed')
    await finish('failed')
    expect(deactivated).toEqual([])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'skipped_inactive', 'skipped_inactive'])
    expect(store.isWorkflowActive(workflowId)).toBe(false)
  })

  it('deactivates once and then finds the workflow inactive for the next failure', async () => {
    const { finish, deactivated, db, workflowId } = scenario(2)
    await finish('failed')
    await finish('failed')
    await finish('failed')
    expect(deactivated).toEqual([workflowId])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'ok', 'skipped_inactive'])
  })

  it('acts only when the failed run is the newest run of the workflow', async () => {
    const { store, end, deactivated, workflowId, db } = scenario(2)
    const older = finishedRun(store, workflowId, 'failed')
    const newer = finishedRun(store, workflowId, 'failed')
    await end(older, 'failed')
    expect(deactivated).toEqual([])
    expect(outcomes(db)).toEqual(['skipped_inactive'])
    await end(newer, 'failed')
    expect(deactivated).toEqual([workflowId])
  })

  it('is not held back by a newer run that is only queued or running', async () => {
    const { store, end, deactivated, workflowId, db } = scenario(2)
    const first = finishedRun(store, workflowId, 'failed')
    const second = finishedRun(store, workflowId, 'failed')
    store.createRun({ workflowId, payload: {}, dryRun: false })
    const running = store.createRun({ workflowId, payload: {}, dryRun: false })
    store.markRunRunning(running.id)
    await end(first, 'failed')
    expect(deactivated).toEqual([])
    await end(second, 'failed')
    expect(deactivated).toEqual([workflowId])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'ok'])
  })

  it('deactivates a workflow that fails again and again while its next run is always already queued', async () => {
    const { store, end, deactivated, workflowId, db } = scenario(2)
    for (let index = 0; index < 6; index++) {
      const failed = finishedRun(store, workflowId, 'failed')
      store.createRun({ workflowId, payload: {}, dryRun: false })
      await end(failed, 'failed')
    }
    expect(deactivated).toEqual([workflowId])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'ok', 'skipped_inactive', 'skipped_inactive', 'skipped_inactive', 'skipped_inactive'])
  })

  it('does not count a run that is still queued as one of the last runs, and is not reset by it', async () => {
    const { store, end, deactivated, workflowId } = scenario(2)
    const first = finishedRun(store, workflowId, 'failed')
    store.createRun({ workflowId, payload: {}, dryRun: false })
    const second = finishedRun(store, workflowId, 'failed')
    await end(first, 'failed')
    expect(deactivated).toEqual([])
    await end(second, 'failed')
    expect(deactivated).toEqual([workflowId])
  })

  it('judges runs that finish out of order by the time they finished', async () => {
    const { store, end, deactivated, workflowId, db } = scenario(2)
    const older = store.createRun({ workflowId, payload: {}, dryRun: false })
    const newer = store.createRun({ workflowId, payload: {}, dryRun: false })
    store.finishRun(newer.id, 'failed', 'x')
    await end(newer.id, 'failed')
    expect(deactivated).toEqual([])
    store.finishRun(older.id, 'failed', 'x')
    await end(older.id, 'failed')
    expect(deactivated).toEqual([workflowId])
    expect(outcomes(db)).toEqual(['skipped_inactive', 'ok'])
  })

  it('is reset by a success that finished last, even when that run was created first', async () => {
    const { store, end, deactivated, workflowId } = scenario(2)
    const slow = store.createRun({ workflowId, payload: {}, dryRun: false })
    const first = finishedRun(store, workflowId, 'failed')
    const second = finishedRun(store, workflowId, 'failed')
    store.finishRun(slow.id, 'succeeded')
    await end(first, 'failed')
    await end(second, 'failed')
    expect(deactivated).toEqual([])
  })

  it('does not act with fewer runs than the count', async () => {
    const { finish, deactivated } = scenario(5)
    await finish('failed')
    expect(deactivated).toEqual([])
  })

  it('counts the runs of one workflow only', async () => {
    const { store, finish, deactivated, workflowId } = scenario(2, { scope: 'all' })
    const other = workflowIn(store, 'other')
    store.setWorkflowActive(other, true)
    await finish('failed')
    await finish('failed', false, other)
    expect(deactivated).toEqual([])
    await finish('failed', false, other)
    expect(deactivated).toEqual([other])
    await finish('failed')
    expect(deactivated).toEqual([other, workflowId])
  })

  it('belongs to its scope: a hook of another workflow does not act', async () => {
    const { store, finish, deactivated } = scenario(2)
    const other = workflowIn(store, 'other')
    store.setWorkflowActive(other, true)
    await finish('failed', false, other)
    await finish('failed', false, other)
    expect(deactivated).toEqual([])
  })

  it('does not act on a success, because it listens for failures only', async () => {
    const { finish, deactivated, db } = scenario(2)
    for (let index = 0; index < 5; index++) await finish('succeeded')
    expect(deactivated).toEqual([])
    expect(logRows(db)).toEqual([])
  })

  it('is not stopped by a rule against notify.slack', async () => {
    const context = standalone({ forbidden: () => ['notify.slack'] })
    const workflowId = workflowIn(context.store, 'w')
    context.store.setWorkflowActive(workflowId, true)
    context.store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'deactivateAfterFailures', count: 2 }, enabled: true })
    for (let index = 0; index < 2; index++) {
      context.runner.handle(finished(finishedRun(context.store, workflowId, 'failed'), 'failed', START + index))
      await context.runner.idle()
    }
    expect(context.deactivated).toEqual([workflowId])
  })

  it('writes failed with the code unknown when the deactivation itself throws, and goes on', async () => {
    const context = standalone()
    const workflowId = workflowIn(context.store, 'w')
    context.store.setWorkflowActive(workflowId, true)
    context.store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'deactivateAfterFailures', count: 2 }, enabled: true })
    context.store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    const runner = new HookRunner({
      store: context.store,
      connections: context.table.resolver,
      forbiddenNodes: () => [],
      deactivate: () => {
        throw new Error('deactivation broke: SECRET-DEACTIVATE-TEXT')
      },
    })
    for (let index = 0; index < 2; index++) {
      runner.handle(finished(finishedRun(context.store, workflowId, 'failed'), 'failed', START + index))
      await runner.idle()
    }
    expect(outcomes(context.db)).toEqual(['skipped_inactive', 'ok', 'failed:unknown', 'ok'])
    expect(JSON.stringify(logRows(context.db))).not.toContain('SECRET-DEACTIVATE-TEXT')
  })
})

function cronFailing(name: string) {
  return {
    schemaVersion: 1,
    name,
    nodes: [
      { id: 't1', type: 'trigger.cron@1', config: { expression: '0 3 * * *', timezone: 'utc' } },
      { id: 'n1', type: 'test.fail@1', config: {} },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  }
}

function setup(options: Parameters<typeof openEngine>[0] = {}) {
  const clock = new ManualClock(START)
  const opened = openEngine({ clock, ...options })
  engines.push(opened.engine)
  const events: EngineEvent[] = []
  opened.engine.on((event) => events.push(event))
  return { ...opened, clock, events }
}

describe('deactivateAfterFailures in the engine', () => {
  it('switches a workflow off through the normal deactivate path after N failures in a row', async () => {
    stubSlack()
    const { engine, events, db, clock } = setup()
    const workflowId = engine.deploy(cronFailing('nightly'))
    await engine.activate(workflowId)
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(engine.listWorkflows()[0]!.active).toBe(true)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(engine.listWorkflows()[0]!.active).toBe(false)
    expect(events.filter((event) => event.type === 'workflow.deactivated')).toEqual([{ type: 'workflow.deactivated', at: clock.now(), workflowId }])
    expect(db.get<{ active: number }>('SELECT active FROM workflows WHERE id = ?', workflowId)?.active).toBe(0)
    const runs = engine.listRuns({ workflowId }).length
    clock.advance(48 * 3_600_000)
    await engine.idle()
    expect(engine.listRuns({ workflowId })).toHaveLength(runs)
  })

  it('counts runs that the trigger starts, like runs that the user starts', async () => {
    stubSlack()
    const { engine, clock } = setup()
    const workflowId = engine.deploy(cronFailing('nightly'))
    await engine.activate(workflowId)
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    clock.advance(17 * 3_600_000 + 60_000)
    await engine.idle()
    expect(engine.listRuns({ workflowId })).toHaveLength(1)
    expect(engine.listWorkflows()[0]!.active).toBe(true)
    clock.advance(24 * 3_600_000)
    await engine.idle()
    expect(engine.listRuns({ workflowId })).toHaveLength(2)
    expect(engine.listWorkflows()[0]!.active).toBe(false)
  })

  it('ignores dry runs', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(cronFailing('nightly'))
    await engine.activate(workflowId)
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    for (let index = 0; index < 4; index++) await engine.startRun(workflowId, {}, { dryRun: true })
    await engine.idle()
    expect(engine.listWorkflows()[0]!.active).toBe(true)
    expect(logRows(db)).toEqual([])
  })

  it('writes exactly one row per matching hook and event, and a deactivation starts nothing else', async () => {
    stubSlack()
    const { engine, db, events } = setup()
    const workflowId = engine.deploy(cronFailing('nightly'))
    await engine.activate(workflowId)
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: { type: 'record' } }))
    await engine.startRun(workflowId, {})
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(logRows(db)).toHaveLength(4)
    expect(outcomes(db)).toEqual(['skipped_inactive', 'ok', 'ok', 'ok'])
    expect(events.map((event) => event.type).filter((type) => type === 'workflow.deactivated')).toHaveLength(1)
    expect(engine.listRuns({ workflowId })).toHaveLength(2)
  })

  it('reads the history from the database, so that the count survives a restart', async () => {
    stubSlack()
    const dir = mkdtempSync(join(tmpdir(), 'rill-hooks-deactivate-'))
    try {
      const file = join(dir, 'rill.db')
      const firstDb = Db.open(file)
      const first = openEngine({ db: firstDb, clock: new ManualClock(START) })
      const workflowId = first.engine.deploy(cronFailing('nightly'))
      await first.engine.activate(workflowId)
      first.engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
      await first.engine.startRun(workflowId, {})
      await first.engine.idle()
      await first.engine.shutdown()
      firstDb.close()

      const secondDb = Db.open(file)
      const second = openEngine({ db: secondDb, clock: new ManualClock(START + 3_600_000) })
      engines.push(second.engine)
      await second.engine.resumeActive()
      expect(second.engine.listWorkflows()[0]!.active).toBe(true)
      await second.engine.startRun(workflowId, {})
      await second.engine.idle()
      expect(second.engine.listWorkflows()[0]!.active).toBe(false)
      await second.engine.shutdown()
      engines.length = 0
      secondDb.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not touch a workflow that was not active', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(cronFailing('nightly'))
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    await engine.startRun(workflowId, {})
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(outcomes(db)).toEqual(['skipped_inactive', 'skipped_inactive'])
    expect(engine.listWorkflows()[0]!.active).toBe(false)
  })

  it('is not reset by a success of another workflow', async () => {
    stubSlack()
    const { engine } = setup()
    const failing = engine.deploy(cronFailing('nightly'))
    const fine = engine.deploy(echoWorkflow('fine'))
    await engine.activate(failing)
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    await engine.startRun(failing, {})
    await engine.startRun(fine, {})
    await engine.idle()
    expect(engine.listWorkflows().find((workflow) => workflow.id === failing)!.active).toBe(true)
    await engine.startRun(failing, {})
    await engine.idle()
    expect(engine.listWorkflows().find((workflow) => workflow.id === failing)!.active).toBe(false)
  })
})
