import { describe, expect, it } from 'vitest'
import type { Engine } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { createTestEngine, linearWorkflow } from './helpers'

const trigger = { id: 't1', type: 'trigger.manual@1' }

function record(engine: Engine): EngineEvent[] {
  const events: EngineEvent[] = []
  engine.on((event) => events.push(event))
  return events
}

const types = (events: EngineEvent[]) => events.map((e) => e.type)

describe('engine events', () => {
  it('reports a run and its steps in order', async () => {
    const { engine } = createTestEngine()
    const events = record(engine)
    const id = engine.deploy(
      linearWorkflow([
        trigger,
        { id: 'a', type: 'test.echo@1', config: { value: 1 } },
        { id: 'b', type: 'test.echo@1', config: { value: 2 } },
      ]),
    )
    const result = await engine.startRun(id, {})
    expect(types(events)).toEqual([
      'run.started',
      'step.started',
      'step.succeeded',
      'step.started',
      'step.succeeded',
      'run.finished',
    ])
    expect(events[0]).toMatchObject({ type: 'run.started', runId: result.runId, workflowId: id, dryRun: false })
    expect(events[1]).toMatchObject({ type: 'step.started', nodeId: 'a', attempt: 1 })
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded', error: null })
    expect(typeof events[0]?.at).toBe('number')
  })

  it('marks a failed attempt that will be retried', async () => {
    const { engine } = createTestEngine()
    const events = record(engine)
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'a', type: 'test.flaky@1', config: { failTimes: 1 }, retry: { maxAttempts: 2 } }]),
    )
    await engine.startRun(id)
    expect(types(events)).toEqual([
      'run.started',
      'step.started',
      'step.failed',
      'step.started',
      'step.succeeded',
      'run.finished',
    ])
    expect(events[2]).toMatchObject({ type: 'step.failed', attempt: 1, willRetry: true, error: 'transient 1' })
    expect(events[3]).toMatchObject({ type: 'step.started', attempt: 2 })
  })

  it('reports a final failure and a failed run', async () => {
    const { engine } = createTestEngine()
    const events = record(engine)
    const id = engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'test.fail@1' }]))
    await engine.startRun(id)
    expect(events.find((e) => e.type === 'step.failed')).toMatchObject({ willRetry: false, error: 'permanent' })
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'failed', error: 'node a failed: permanent' })
  })

  it('reports a config error as a started and failed step', async () => {
    const { engine } = createTestEngine()
    const events = record(engine)
    const id = engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: {} }]))
    await engine.startRun(id)
    expect(types(events)).toEqual(['run.started', 'step.started', 'step.failed', 'run.finished'])
    expect(events[2]).toMatchObject({ willRetry: false })
  })

  it('reports skipped and tolerated steps', async () => {
    const { engine } = createTestEngine()
    const events = record(engine)
    const wf = {
      schemaVersion: 1,
      name: 'mixed',
      nodes: [
        { id: 't1', type: 'trigger.manual@1', config: {} },
        { id: 'c1', type: 'condition@1', config: { left: 5, operator: 'gt', right: '3' }, onError: 'continue' },
        { id: 'a', type: 'test.echo@1', config: { value: 'a' } },
        { id: 'b', type: 'test.echo@1', config: { value: 'b' } },
      ],
      edges: [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'a' },
        { from: 'c1', to: 'b', when: 'true' },
      ],
    }
    await engine.startRun(engine.deploy(wf))
    expect(events.find((e) => e.type === 'step.continued')).toMatchObject({ nodeId: 'c1', attempt: 1 })
    expect(events.find((e) => e.type === 'step.skipped')).toMatchObject({ nodeId: 'b' })
  })

  it('never lets a throwing listener break the run, and stops after unsubscribe', async () => {
    const { engine } = createTestEngine()
    engine.on(() => {
      throw new Error('bad listener')
    })
    const seen: string[] = []
    const off = engine.on((event) => seen.push(event.type))
    const id = engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: { value: 1 } }]))
    expect((await engine.startRun(id)).status).toBe('succeeded')
    off()
    const before = seen.length
    await engine.startRun(id)
    expect(seen).toHaveLength(before)
    expect(before).toBeGreaterThan(0)
  })
})
