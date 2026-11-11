import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, WorkflowValidationError } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { ManualClock } from './manual-clock'
import { createTestRegistry } from './helpers'

const START = Date.UTC(2026, 10, 11, 10, 0, 30)

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config })
const workflow = (name: string, trigger: unknown, nodes: unknown[] = []) => ({
  schemaVersion: 1,
  name,
  nodes: [trigger, node('n1', 'test.echo@1', { value: '{{t1.output}}' }), ...nodes],
  edges: [{ from: 't1', to: 'n1' }],
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-trig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(options: { path?: string; connections?: Record<string, string>; maxConcurrentRuns?: number } = {}) {
  const clock = new ManualClock(START)
  const calls: string[] = []
  const events: EngineEvent[] = []
  const db = Db.open(options.path ?? ':memory:')
  const connections = options.connections ?? {}
  const engine = new Engine({
    db,
    registry: createTestRegistry(calls),
    clock,
    sleep: async () => {},
    webhookPort: 0,
    maxConcurrentRuns: options.maxConcurrentRuns,
    connections: { get: (id) => (Object.hasOwn(connections, id) ? connections[id] : undefined) },
  })
  engine.on((event) => events.push(event))
  return { engine, clock, calls, events, db }
}

function gated(options: { maxConcurrentRuns?: number } = {}) {
  const clock = new ManualClock(START)
  const entered: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const registry = createTestRegistry().register(
    defineAction({
      type: 'test.gate@1',
      title: 'Gate',
      description: 'Waits.',
      sideEffect: 'none',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({}),
      execute: async (_config, ctx) => {
        entered.push(ctx.runId)
        await gate
        return {}
      },
    }),
  )
  const events: EngineEvent[] = []
  const engine = new Engine({
    db: Db.open(':memory:'),
    registry,
    clock,
    sleep: async () => {},
    maxConcurrentRuns: options.maxConcurrentRuns,
  })
  engine.on((event) => events.push(event))
  const gatedWorkflow = (trigger: unknown) => ({
    schemaVersion: 1,
    name: 'gated',
    nodes: [trigger, node('g1', 'test.gate@1')],
    edges: [{ from: 't1', to: 'g1' }],
  })
  return { engine, clock, entered, events, release: () => release(), gatedWorkflow }
}

describe('deploy', () => {
  it('rejects an invalid trigger config and a bad cron expression', () => {
    const { engine } = setup()
    expect(() => engine.deploy(workflow('a', node('t1', 'trigger.cron@1', { expression: '' })))).toThrow(
      WorkflowValidationError,
    )
    expect(() => engine.deploy(workflow('b', node('t1', 'trigger.cron@1', { expression: '61 * * * *' })))).toThrow(
      'trigger t1: minute out of range 0-59: 61',
    )
    expect(() => engine.deploy(workflow('b2', node('t1', 'trigger.cron@1', { expression: '0 0 31 2 *' })))).toThrow(
      'trigger t1: expression never fires',
    )
    expect(() => engine.deploy(workflow('c', node('t1', 'trigger.folderWatch@1', { folder: '/x', glob: 'a/b' })))).toThrow(
      'glob must match file names only',
    )
    expect(() => engine.deploy(workflow('d', node('t1', 'trigger.webhook@1', { path: 'nope' })))).toThrow(
      'trigger t1: invalid config',
    )
  })

  it('accepts valid trigger configs', () => {
    const { engine } = setup()
    expect(() => engine.deploy(workflow('a', node('t1', 'trigger.cron@1', { expression: '*/5 * * * *' })))).not.toThrow()
    expect(() => engine.deploy(workflow('b', node('t1', 'trigger.webhook@1', { path: '/hooks/a' })))).not.toThrow()
  })

  it('returns the same id when the same workflow is deployed again', () => {
    const { engine } = setup()
    const wf = workflow('same', node('t1', 'trigger.manual@1'))
    expect(engine.deploy(wf)).toBe(engine.deploy(wf))
  })
})

describe('cron activation', () => {
  it('starts runs on schedule and records the trigger in the events', async () => {
    const { engine, clock, calls, events } = setup()
    const id = engine.deploy(workflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await engine.activate(id)
    expect(engine.store.listActiveWorkflowIds()).toEqual([id])
    clock.advance(30_000)
    await engine.idle()
    expect(calls).toEqual(['n1'])
    const run = engine.store.listRunsByStatus('succeeded')[0]
    expect(run?.payload).toMatchObject({ scheduledFor: new Date(Date.UTC(2026, 10, 11, 10, 1)).toISOString() })
    expect(events.map((e) => e.type)).toEqual([
      'workflow.activated',
      'trigger.fired',
      'run.started',
      'step.started',
      'step.succeeded',
      'run.finished',
    ])
    await engine.shutdown()
  })

  it('is a no-op to activate twice, and deactivate stops the schedule and clears the flag', async () => {
    const { engine, clock, calls, events } = setup()
    const id = engine.deploy(workflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await engine.activate(id)
    await engine.activate(id)
    expect(clock.pending).toBe(1)
    engine.deactivate(id)
    expect(engine.store.listActiveWorkflowIds()).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'workflow.deactivated', workflowId: id })
    clock.advance(5 * 60_000)
    await engine.idle()
    expect(calls).toEqual([])
    await engine.shutdown()
  })

  it('treats the time a workflow was switched off as not missed', async () => {
    const { engine, clock, calls, events } = setup()
    const id = engine.deploy(
      workflow('cron', node('t1', 'trigger.cron@1', { expression: '0 * * * *', timezone: 'utc', catchUp: 'once' })),
    )
    await engine.activate(id)
    engine.deactivate(id)
    clock.jump(5 * 3_600_000)
    await engine.activate(id)
    await engine.idle()
    expect(calls).toEqual([])
    expect(events.some((e) => e.type === 'trigger.skipped')).toBe(false)
    await engine.shutdown()
  })

  it('skips a tick while the previous run is still active', async () => {
    const { engine, clock, entered, events, release, gatedWorkflow } = gated()
    const id = engine.deploy(gatedWorkflow(node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await engine.activate(id)
    clock.advance(30_000)
    expect(entered).toHaveLength(1)
    clock.advance(60_000)
    expect(entered).toHaveLength(1)
    expect(events.filter((e) => e.type === 'trigger.skipped')).toHaveLength(1)
    release()
    await engine.idle()
    expect(engine.store.listRunsByStatus('succeeded')).toHaveLength(1)
    await engine.shutdown()
  })

  it('resumes active workflows after a restart and applies the missed-schedule policy', async () => {
    const path = join(dir, 'restart.db')
    const first = setup({ path })
    const id = first.engine.deploy(
      workflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc', catchUp: 'once' })),
    )
    await first.engine.activate(id)
    await first.engine.shutdown()
    first.db.close()

    const second = setup({ path })
    second.clock.jump(10 * 60_000)
    await second.engine.resumeActive()
    await second.engine.idle()
    expect(second.calls).toEqual(['n1'])
    expect(second.engine.store.listActiveWorkflowIds()).toEqual([id])
    await second.engine.shutdown()
    second.db.close()
  })
})

describe('activation races', () => {
  it('does not leak a runtime when the same workflow is activated twice at once', async () => {
    const { engine, clock, calls } = setup()
    const id = engine.deploy(workflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await Promise.all([engine.activate(id), engine.activate(id)])
    expect(clock.pending).toBe(1)
    engine.deactivate(id)
    expect(clock.pending).toBe(0)
    clock.advance(3 * 60_000)
    await engine.idle()
    expect(calls).toEqual([])
    await engine.shutdown()
  })

  it('honours a deactivate that arrives while the activation is still running', async () => {
    const { engine, clock, events } = setup()
    const id = engine.deploy(workflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    const pending = engine.activate(id)
    engine.deactivate(id)
    await pending
    expect(engine.store.listActiveWorkflowIds()).toEqual([])
    expect(clock.pending).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['workflow.deactivated'])
    await engine.shutdown()
  })

  it('serves two webhook workflows activated at the same time from one server', async () => {
    const { engine } = setup()
    const a = engine.deploy(workflow('a', node('t1', 'trigger.webhook@1', { path: '/hooks/a' })))
    const b = engine.deploy(workflow('b', node('t1', 'trigger.webhook@1', { path: '/hooks/b' })))
    await Promise.all([engine.activate(a), engine.activate(b)])
    const port = engine.webhookPort()
    expect((await fetch(`http://127.0.0.1:${port}/hooks/a`, { method: 'POST' })).status).toBe(202)
    expect((await fetch(`http://127.0.0.1:${port}/hooks/b`, { method: 'POST' })).status).toBe(202)
    await engine.idle()
    await engine.shutdown()
    expect(engine.webhookPort()).toBeUndefined()
  })
})

describe('recover', () => {
  it('does not run a run twice when it is called while runs are queued or running', async () => {
    const { engine, entered, release, gatedWorkflow } = gated({ maxConcurrentRuns: 1 })
    const id = engine.deploy(gatedWorkflow(node('t1', 'trigger.manual@1')))
    const first = engine.enqueueRun(id)
    const second = engine.enqueueRun(id)
    expect(await engine.recover()).toEqual([])
    expect(entered).toHaveLength(1)
    release()
    const results = await Promise.all([first.done, second.done])
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'succeeded'])
    expect(entered).toHaveLength(2)
  })
})

describe('activation errors', () => {
  it('refuses to activate a manual workflow or an unknown id', async () => {
    const { engine } = setup()
    const id = engine.deploy(workflow('manual', node('t1', 'trigger.manual@1')))
    await expect(engine.activate(id)).rejects.toThrow('manual triggers cannot be activated')
    await expect(engine.activate('missing')).rejects.toThrow('workflow not found: missing')
    expect(engine.store.listActiveWorkflowIds()).toEqual([])
  })

  it('refuses a webhook with an unknown secret connection', async () => {
    const { engine } = setup()
    const id = engine.deploy(
      workflow('hook', node('t1', 'trigger.webhook@1', { path: '/hooks/a', secretConnection: 'nope' })),
    )
    await expect(engine.activate(id)).rejects.toThrow('unknown connection: nope')
    expect(engine.store.listActiveWorkflowIds()).toEqual([])
    await engine.shutdown()
  })

  it('refuses a folder trigger outside the allowed roots and a missing folder', async () => {
    const clock = new ManualClock(START)
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    const engine = new Engine({
      db: Db.open(':memory:'),
      registry: createTestRegistry(),
      clock,
      allowedRoots: [allowed],
    })
    const outside = engine.deploy(workflow('out', node('t1', 'trigger.folderWatch@1', { folder: dir })))
    await expect(engine.activate(outside)).rejects.toThrow('outside the allowed folders')
    const missing = engine.deploy(workflow('gone', node('t1', 'trigger.folderWatch@1', { folder: join(allowed, 'gone') })))
    await expect(engine.activate(missing)).rejects.toThrow('folder does not exist')
  })

  it('reports workflows that cannot be resumed instead of throwing', async () => {
    const path = join(dir, 'resume-fail.db')
    const folder = join(dir, 'watched')
    mkdirSync(folder)
    const first = setup({ path })
    const id = first.engine.deploy(workflow('folder', node('t1', 'trigger.folderWatch@1', { folder })))
    await first.engine.activate(id)
    await first.engine.shutdown()
    first.db.close()
    rmSync(folder, { recursive: true })

    const second = setup({ path })
    await expect(second.engine.resumeActive()).resolves.toBeUndefined()
    expect(second.events.find((e) => e.type === 'trigger.error')).toMatchObject({ workflowId: id })
    await second.engine.shutdown()
    second.db.close()
  })
})

describe('folder activation', () => {
  it('runs the workflow for a new file', async () => {
    const folder = join(dir, 'in')
    mkdirSync(folder)
    const { engine, clock, calls } = setup()
    const id = engine.deploy(
      workflow('folder', node('t1', 'trigger.folderWatch@1', { folder, pollMs: 1000, stableMs: 0 })),
    )
    await engine.activate(id)
    writeFileSync(join(folder, 'receipt.pdf'), 'pdf')
    clock.advance(1000)
    await engine.idle()
    expect(calls).toEqual(['n1'])
    const run = engine.store.listRunsByStatus('succeeded')[0]
    expect(run?.payload).toMatchObject({ name: 'receipt.pdf', extension: '.pdf', bytes: 3 })
    clock.advance(5000)
    await engine.idle()
    expect(calls).toEqual(['n1'])
    await engine.shutdown()
  })

  it('delivers nothing after deactivate even when a scan is due', async () => {
    const folder = join(dir, 'in')
    mkdirSync(folder)
    const { engine, clock, calls } = setup()
    const id = engine.deploy(
      workflow('folder', node('t1', 'trigger.folderWatch@1', { folder, pollMs: 1000, stableMs: 0 })),
    )
    await engine.activate(id)
    writeFileSync(join(folder, 'late.pdf'), 'pdf')
    engine.deactivate(id)
    clock.advance(5000)
    await engine.idle()
    expect(calls).toEqual([])
    await engine.shutdown()
  })
})

describe('webhook activation', () => {
  it('starts a run for an authorised request and keeps secrets out of the payload', async () => {
    const { engine, calls } = setup({ connections: { hook: 's3cret' } })
    const id = engine.deploy(
      workflow('hook', node('t1', 'trigger.webhook@1', { path: '/hooks/receipts', secretConnection: 'hook' })),
    )
    await engine.activate(id)
    const port = engine.webhookPort()
    expect(port).toBeGreaterThan(0)

    const denied = await fetch(`http://127.0.0.1:${port}/hooks/receipts`, { method: 'POST', body: '{}' })
    expect(denied.status).toBe(401)
    expect(engine.store.listRunsByStatus('queued')).toEqual([])

    const accepted = await fetch(`http://127.0.0.1:${port}/hooks/receipts?src=x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rill-secret': 's3cret' },
      body: JSON.stringify({ amount: 12 }),
    })
    expect(accepted.status).toBe(202)
    const { runId } = (await accepted.json()) as { runId: string }
    await engine.idle()
    const run = engine.store.getRun(runId)
    expect(run.status).toBe('succeeded')
    expect(run.payload).toMatchObject({ path: '/hooks/receipts', query: { src: 'x' }, body: { amount: 12 } })
    expect(JSON.stringify(run.payload)).not.toContain('s3cret')
    expect(calls).toEqual(['n1'])

    engine.deactivate(id)
    const gone = await fetch(`http://127.0.0.1:${port}/hooks/receipts`, { method: 'POST', body: '{}' })
    expect(gone.status).toBe(404)
    await engine.shutdown()
  })

  it('closes the webhook server on shutdown', async () => {
    const { engine } = setup()
    const id = engine.deploy(workflow('hook', node('t1', 'trigger.webhook@1', { path: '/hooks/a' })))
    await engine.activate(id)
    const port = engine.webhookPort()
    await engine.shutdown()
    expect(engine.webhookPort()).toBeUndefined()
    await expect(fetch(`http://127.0.0.1:${port}/hooks/a`, { method: 'POST' })).rejects.toThrow()
  })
})

describe('shutdown', () => {
  it('waits for running runs and keeps the active flags', async () => {
    const { engine, clock } = setup()
    const id = engine.deploy(workflow('cron', node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await engine.activate(id)
    clock.advance(30_000)
    await engine.shutdown()
    expect(engine.store.listRunsByStatus('succeeded')).toHaveLength(1)
    expect(engine.store.listActiveWorkflowIds()).toEqual([id])
    expect(clock.pending).toBe(0)
  })

  it('does not resolve until a run that is still executing has finished', async () => {
    const { engine, clock, release, gatedWorkflow } = gated()
    const id = engine.deploy(gatedWorkflow(node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })))
    await engine.activate(id)
    clock.advance(30_000)
    let finished = false
    const shutdown = engine.shutdown().then(() => {
      finished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(finished).toBe(false)
    release()
    await shutdown
    expect(engine.store.listRunsByStatus('succeeded')).toHaveLength(1)
  })
})
