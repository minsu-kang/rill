import { EngineEventSchema } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { ManualClock } from './manual-clock'
import { createTestEngine, createTestRegistry, linearWorkflow } from './helpers'

const trigger = { id: 't1', type: 'trigger.manual@1' }
const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config })

function problems(events: EngineEvent[]): string[] {
  return events
    .filter((event) => !Value.Check(EngineEventSchema, event))
    .map((event) => JSON.stringify(event))
}

describe('every event the engine emits matches the protocol schema', () => {
  it('for runs, retries, failures, skipped and tolerated steps', async () => {
    const { engine } = createTestEngine()
    const events: EngineEvent[] = []
    engine.on((event) => events.push(event))
    const workflows = [
      linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: { value: 1 } }]),
      linearWorkflow([trigger, { id: 'a', type: 'test.flaky@1', config: { failTimes: 1 }, retry: { maxAttempts: 2 } }]),
      linearWorkflow([trigger, { id: 'a', type: 'test.fail@1' }]),
      linearWorkflow([trigger, { id: 'a', type: 'test.flaky@1', config: { failTimes: '{{t1.output.n}}' } }]),
      {
        schemaVersion: 1,
        name: 'branches',
        nodes: [
          node('t1', 'trigger.manual@1'),
          { ...node('c1', 'condition@1', { left: 5, operator: 'gt', right: '3' }), onError: 'continue' },
          node('a', 'test.echo@1', { value: 'a' }),
          node('b', 'test.echo@1', { value: 'b' }),
        ],
        edges: [
          { from: 't1', to: 'c1' },
          { from: 'c1', to: 'a' },
          { from: 'c1', to: 'b', when: 'true' },
        ],
      },
    ]
    for (const workflow of workflows) await engine.startRun(engine.deploy(workflow), {})
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(['run.started', 'step.started', 'step.succeeded', 'step.failed', 'step.skipped', 'step.continued', 'run.finished']),
    )
    expect(problems(events)).toEqual([])
  })

  it('for trigger and activation events', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 11, 10, 0, 30))
    const engine = new Engine({ db: Db.open(':memory:'), registry: createTestRegistry(), clock, sleep: async () => {} })
    const events: EngineEvent[] = []
    engine.on((event) => events.push(event))
    const id = engine.deploy({
      schemaVersion: 1,
      name: 'cron',
      nodes: [node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' }), node('n1', 'test.echo@1', { value: 1 })],
      edges: [{ from: 't1', to: 'n1' }],
    })
    await engine.activate(id)
    clock.advance(30_000)
    await engine.idle()
    engine.deactivate(id)
    await engine.shutdown()
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['workflow.activated', 'trigger.fired', 'workflow.deactivated']))
    expect(problems(events)).toEqual([])
  })
})
