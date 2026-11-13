import { defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, WorkflowBusyError } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { workflowHash, type StoredPlan } from '../src/plans'
import { NotFoundError } from '../src/store'
import { createTestRegistry } from './helpers'
import { ManualClock } from './manual-clock'
import { plainWorkflow } from './plan-helpers'

const START = Date.UTC(2026, 10, 11, 10, 0, 30)

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config })
const echoWorkflow = (name: string, trigger: unknown = node('t1', 'trigger.manual@1')) => ({
  schemaVersion: 1,
  name,
  nodes: [trigger, node('n1', 'test.echo@1', { value: '{{t1.output}}' })],
  edges: [{ from: 't1', to: 'n1' }],
})

const TABLES = ['workflows', 'runs', 'step_attempts', 'idempotency_journal', 'trigger_state', 'seen_files', 'plans', 'memory_items'] as const

const engines: Engine[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function setup(options: { release?: Promise<void> } = {}) {
  const clock = new ManualClock(START)
  const calls: string[] = []
  const events: EngineEvent[] = []
  const entered: string[] = []
  const registry = createTestRegistry(calls).register(
    defineAction({
      type: 'test.gate@1',
      title: 'Gate',
      description: 'Waits.',
      sideEffect: 'none',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({}),
      execute: async (_config, ctx) => {
        entered.push(ctx.runId)
        await options.release
        return {}
      },
    }),
  )
  const db = Db.open(':memory:')
  const engine = new Engine({ db, registry, clock, sleep: async () => {}, webhookPort: 0, maxConcurrentRuns: 1 })
  engine.on((event) => events.push(event))
  engines.push(engine)
  return { engine, db, clock, calls, events, entered }
}

type Setup = ReturnType<typeof setup>

function count(db: Db, table: (typeof TABLES)[number]): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
}

function counts(db: Db): Record<string, number> {
  return Object.fromEntries(TABLES.map((table) => [table, count(db, table)]))
}

function rowsOf(db: Db, workflowId: string): Record<string, unknown[]> {
  return {
    workflows: db.all('SELECT * FROM workflows WHERE id = ?', workflowId),
    runs: db.all('SELECT * FROM runs WHERE workflow_id = ? ORDER BY id', workflowId),
    step_attempts: db.all('SELECT * FROM step_attempts WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?) ORDER BY id', workflowId),
    idempotency_journal: db.all(
      'SELECT * FROM idempotency_journal WHERE key IN (SELECT idempotency_key FROM step_attempts WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?)) ORDER BY key',
      workflowId,
    ),
    trigger_state: db.all('SELECT * FROM trigger_state WHERE workflow_id = ?', workflowId),
    seen_files: db.all('SELECT * FROM seen_files WHERE workflow_id = ? ORDER BY fingerprint', workflowId),
    plans: db.all('SELECT * FROM plans WHERE workflow_id = ? ORDER BY id', workflowId),
  }
}

function storedPlan(planId: string): StoredPlan {
  const workflow = plainWorkflow(`plan ${planId}`)
  return {
    planId,
    createdAt: 1000,
    status: 'planned',
    effort: 'high',
    model: 'claude-sonnet-5-5',
    requestText: 'wait a little',
    attachments: [],
    result: { kind: 'workflow', workflow, summary: 'waits', flags: [], needsConfirmation: false },
    meta: null,
    error: null,
    flagKeys: [],
    workflowId: null,
    confirmed: null,
    memoryIds: [],
    workflowHash: workflowHash(workflow),
  }
}

async function fill(env: Setup, workflowId: string, tag: string): Promise<string[]> {
  const first = await env.engine.startRun(workflowId, { tag, n: 1 })
  const second = await env.engine.startRun(workflowId, { tag, n: 2 }, { dryRun: true })
  const failed = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
  env.engine.store.finishRun(failed.id, 'failed', 'boom')
  const runIds = [first.runId, second.runId, failed.id]
  for (const runId of runIds.slice(0, 2)) env.engine.store.journal().put(`${runId}:n1`, 'done', `data-${tag}`)
  env.engine.store.saveTriggerState(workflowId, { nextFireAt: 5000, lastFireAt: 4000 })
  env.engine.store.markFileSeen(workflowId, `fp-${tag}`, `/in/${tag}.pdf`, first.runId)
  env.engine.store.savePlan(storedPlan(`plan-${tag}`))
  env.engine.store.markPlanDeployed(`plan-${tag}`, workflowId, [])
  return runIds
}

describe('deleteWorkflow', () => {
  it('removes every row of the workflow and nothing of the others', async () => {
    const env = setup()
    const doomed = env.engine.deploy(echoWorkflow('doomed'))
    const kept = env.engine.deploy(echoWorkflow('kept'))
    await fill(env, doomed, 'a')
    await fill(env, kept, 'b')
    env.engine.store.journal().put('foreign:key', 'done', 'x')
    env.engine.saveMemory({ text: 'My receipts live in ~/Receipts' })
    const keptBefore = rowsOf(env.db, kept)
    const before = counts(env.db)
    expect(rowsOf(env.db, doomed).step_attempts!.length).toBeGreaterThan(0)
    expect(rowsOf(env.db, doomed).idempotency_journal!).toHaveLength(2)

    env.engine.deleteWorkflow(doomed)

    const gone = rowsOf(env.db, doomed)
    for (const [table, rows] of Object.entries(gone)) {
      if (table !== 'plans') expect(rows, table).toEqual([])
    }
    expect(rowsOf(env.db, kept)).toEqual(keptBefore)
    expect(counts(env.db)).toEqual({
      workflows: before.workflows! - 1,
      runs: before.runs! - 3,
      step_attempts: before.step_attempts! - 2,
      idempotency_journal: before.idempotency_journal! - 2,
      trigger_state: before.trigger_state! - 1,
      seen_files: before.seen_files! - 1,
      plans: before.plans!,
      memory_items: before.memory_items!,
    })
    expect(env.db.get('SELECT 1 AS found FROM idempotency_journal WHERE key = ?', 'foreign:key')).toBeDefined()
    expect(env.engine.listWorkflows().map((summary) => summary.id)).toEqual([kept])
    expect(env.engine.listRuns({ workflowId: doomed })).toEqual([])
  })

  it('keeps the plans of the workflow with the link cleared and keeps every memory note', async () => {
    const env = setup()
    const doomed = env.engine.deploy(echoWorkflow('doomed'))
    const other = env.engine.deploy(echoWorkflow('other'))
    await fill(env, doomed, 'a')
    await fill(env, other, 'b')
    const note = env.engine.saveMemory({ text: 'Keep the invoices in ~/Invoices' })
    const planBefore = env.engine.getPlan('plan-a')
    expect(planBefore.workflowId).toBe(doomed)

    env.engine.deleteWorkflow(doomed)

    expect(env.engine.getPlan('plan-a')).toEqual({ ...planBefore, workflowId: null })
    expect(env.engine.getPlan('plan-b').workflowId).toBe(other)
    expect(env.engine.listPlans().map((plan) => plan.planId).sort()).toEqual(['plan-a', 'plan-b'])
    expect(env.engine.listMemory()).toEqual([note])
  })

  it('keeps what the user confirmed on a plan after its workflow is deleted and overwrites it on a new deploy', async () => {
    const env = setup()
    const workflow = plainWorkflow('flagged')
    env.engine.store.savePlan({
      ...storedPlan('flagged'),
      result: { kind: 'workflow', workflow, summary: 'flagged', flags: [], needsConfirmation: false },
      flagKeys: ['k1', 'k2'],
      workflowHash: workflowHash(workflow),
    })
    const first = env.engine.deployPlan('flagged', ['k1', 'k2'])
    env.engine.deleteWorkflow(first)
    expect(env.engine.getPlan('flagged')).toMatchObject({ workflowId: null, confirmed: ['k1', 'k2'] })
    const second = env.engine.deployPlan('flagged', ['k2', 'k1', 'k1'])
    expect(env.engine.getPlan('flagged')).toMatchObject({ workflowId: second, confirmed: ['k2', 'k1'] })
  })

  it('lets a plan whose workflow was deleted be deployed again', async () => {
    const env = setup()
    env.engine.store.savePlan(storedPlan('again'))
    const first = env.engine.deployPlan('again', [])
    env.engine.deleteWorkflow(first)
    expect(env.engine.getPlan('again').workflowId).toBeNull()
    const second = env.engine.deployPlan('again', [])
    expect(second).not.toBe(first)
    expect(env.engine.getPlan('again').workflowId).toBe(second)
  })

  it('stops the trigger of an active workflow before it deletes it', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await env.engine.activate(id)
    expect(env.engine.store.listActiveWorkflowIds()).toEqual([id])
    expect(env.clock.pending).toBe(1)

    env.engine.deleteWorkflow(id)

    expect(env.clock.pending).toBe(0)
    expect(env.engine.store.listActiveWorkflowIds()).toEqual([])
    env.clock.advance(5 * 60_000)
    await env.engine.idle()
    expect(env.calls).toEqual([])
    expect(count(env.db, 'runs')).toBe(0)
    expect(count(env.db, 'trigger_state')).toBe(0)
    expect(env.events.map((event) => event.type)).toEqual(['workflow.activated', 'workflow.deactivated', 'workflow.deleted'])
  })

  it('emits only workflow.deleted for a workflow that is not active', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('idle'))
    env.engine.deleteWorkflow(id)
    expect(env.events.map((event) => event.type)).toEqual(['workflow.deleted'])
  })

  it('emits workflow.deactivated before workflow.deleted for an active workflow', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await env.engine.activate(id)
    env.events.length = 0
    env.engine.deleteWorkflow(id)
    expect(env.events.map((event) => event.type)).toEqual(['workflow.deactivated', 'workflow.deleted'])
  })

  it('honours a delete that arrives while the activation is still running', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    const pending = env.engine.activate(id)
    env.engine.deleteWorkflow(id)
    await pending.catch(() => undefined)
    expect(env.clock.pending).toBe(0)
    expect(count(env.db, 'workflows')).toBe(0)
    expect(count(env.db, 'trigger_state')).toBe(0)
  })

  it('emits workflow.deleted once, with the id, after the rows are gone', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('one'))
    let remaining: number | undefined
    env.engine.on((event) => {
      if (event.type === 'workflow.deleted') remaining = count(env.db, 'workflows')
    })
    env.engine.deleteWorkflow(id)
    const deleted = env.events.filter((event) => event.type === 'workflow.deleted')
    expect(deleted).toEqual([{ type: 'workflow.deleted', workflowId: id, at: START }])
    expect(remaining).toBe(0)
  })

  it('answers NOT_FOUND for an unknown id, and for the same id a second time, without an event', () => {
    const env = setup()
    expect(() => env.engine.deleteWorkflow('nope')).toThrow(NotFoundError)
    const id = env.engine.deploy(echoWorkflow('twice'))
    env.engine.deleteWorkflow(id)
    expect(() => env.engine.deleteWorkflow(id)).toThrow(NotFoundError)
    expect(env.events.filter((event) => event.type === 'workflow.deleted')).toHaveLength(1)
  })

  it('refuses while a run is running, deletes nothing and keeps the workflow active', async () => {
    let release!: () => void
    const env = setup({ release: new Promise<void>((resolve) => (release = resolve)) })
    const id = env.engine.deploy({
      schemaVersion: 1,
      name: 'gated',
      nodes: [node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' }), node('g1', 'test.gate@1')],
      edges: [{ from: 't1', to: 'g1' }],
    })
    await env.engine.activate(id)
    const { done } = env.engine.enqueueRun(id)
    await Promise.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(env.entered).toHaveLength(1)
    const before = counts(env.db)

    expect(() => env.engine.deleteWorkflow(id)).toThrow(WorkflowBusyError)

    expect(counts(env.db)).toEqual(before)
    expect(env.engine.store.listActiveWorkflowIds()).toEqual([id])
    expect(env.events.map((event) => event.type)).not.toContain('workflow.deleted')
    expect(env.events.map((event) => event.type)).not.toContain('workflow.deactivated')
    release()
    await done
    env.engine.deleteWorkflow(id)
    expect(count(env.db, 'workflows')).toBe(0)
  })

  it('refuses while a run is only queued', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('queued'))
    env.engine.store.createRun({ workflowId: id, payload: {}, dryRun: false })
    expect(() => env.engine.deleteWorkflow(id)).toThrow(WorkflowBusyError)
    expect(count(env.db, 'workflows')).toBe(1)
    expect(count(env.db, 'runs')).toBe(1)
  })

  it('is all or nothing when the delete fails half way', async () => {
    const env = setup()
    const doomed = env.engine.deploy(echoWorkflow('doomed'))
    await fill(env, doomed, 'a')
    env.engine.deactivate(doomed)
    env.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON workflows BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    const before = counts(env.db)
    const rows = rowsOf(env.db, doomed)

    expect(() => env.engine.deleteWorkflow(doomed)).toThrow('injected failure')

    expect(counts(env.db)).toEqual(before)
    expect(rowsOf(env.db, doomed)).toEqual(rows)
    expect(env.events.map((event) => event.type)).not.toContain('workflow.deleted')
    env.db.exec('DROP TRIGGER fail_delete')
    env.engine.deleteWorkflow(doomed)
    expect(count(env.db, 'workflows')).toBe(0)
  })

  it('leaves an active workflow stopped but stored when the delete fails', async () => {
    const env = setup()
    const id = env.engine.deploy(echoWorkflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await env.engine.activate(id)
    env.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON workflows BEGIN SELECT RAISE(ABORT, 'injected failure'); END")

    expect(() => env.engine.deleteWorkflow(id)).toThrow('injected failure')

    expect(env.engine.listWorkflows()).toMatchObject([{ id, active: false }])
    expect(env.clock.pending).toBe(0)
    expect(env.events.map((event) => event.type)).toEqual(['workflow.activated', 'workflow.deactivated'])
  })
})
