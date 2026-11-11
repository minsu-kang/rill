import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RunQueue } from '../src/queue'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('RunQueue', () => {
  it('runs at most `limit` jobs at once and starts waiting jobs in order', async () => {
    const queue = new RunQueue(2)
    const started: number[] = []
    const gates = [deferred(), deferred(), deferred()]
    const results = gates.map((gate, i) =>
      queue.run(async () => {
        started.push(i)
        await gate.promise
        return i
      }),
    )
    expect(started).toEqual([0, 1])
    expect(queue.active).toBe(2)
    expect(queue.waiting).toBe(1)
    gates[0]!.resolve()
    await results[0]
    expect(started).toEqual([0, 1, 2])
    gates[1]!.resolve()
    gates[2]!.resolve()
    expect(await Promise.all(results)).toEqual([0, 1, 2])
    await queue.idle()
    expect(queue.active).toBe(0)
    expect(queue.waiting).toBe(0)
  })

  it('propagates a job error and keeps serving the queue', async () => {
    const queue = new RunQueue(1)
    const failing = queue.run(async () => {
      throw new Error('boom')
    })
    const after = queue.run(async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    await expect(after).resolves.toBe('ok')
  })

  it('survives a job that throws before returning a promise', async () => {
    const queue = new RunQueue(1)
    const failing = queue.run((() => {
      throw new Error('sync boom')
    }) as () => Promise<never>)
    await expect(failing).rejects.toThrow('sync boom')
    await expect(queue.run(async () => 1)).resolves.toBe(1)
    expect(queue.active).toBe(0)
  })

  it('resolves idle at once when nothing is running and after the last job otherwise', async () => {
    const queue = new RunQueue(1)
    await queue.idle()
    const gate = deferred()
    const job = queue.run(() => gate.promise)
    let idle = false
    void queue.idle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    gate.resolve()
    await job
    await queue.idle()
    expect(idle).toBe(true)
  })

  it('rejects a limit that is not a positive integer', () => {
    expect(() => new RunQueue(0)).toThrow(RangeError)
    expect(() => new RunQueue(1.5)).toThrow(RangeError)
  })
})

describe('Engine run queue', () => {
  it('limits concurrent runs and exposes the run id before the run finishes', async () => {
    const entered: string[] = []
    const gate = deferred()
    const registry = createCoreRegistry().register(
      defineAction({
        type: 'test.gate@1',
        title: 'Gate',
        description: 'Waits for the gate.',
        sideEffect: 'none',
        configSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({}),
        execute: async (_config, ctx) => {
          entered.push(ctx.runId)
          await gate.promise
          return {}
        },
      }),
    )
    const engine = new Engine({ db: Db.open(':memory:'), registry, maxConcurrentRuns: 2 })
    const id = engine.deploy({
      schemaVersion: 1,
      name: 'gate',
      nodes: [
        { id: 't1', type: 'trigger.manual@1', config: {} },
        { id: 'g1', type: 'test.gate@1', config: {} },
      ],
      edges: [{ from: 't1', to: 'g1' }],
    })

    const runs = [engine.enqueueRun(id), engine.enqueueRun(id), engine.enqueueRun(id)]
    expect(new Set(runs.map((r) => r.runId)).size).toBe(3)
    expect(engine.store.getRun(runs[2]!.runId).status).toBe('queued')
    expect(entered).toHaveLength(2)

    gate.resolve()
    const results = await Promise.all(runs.map((r) => r.done))
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(entered).toHaveLength(3)
    await engine.idle()
  })

  it('keeps startRun working through the queue', async () => {
    const engine = new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry() })
    const id = engine.deploy({
      schemaVersion: 1,
      name: 'plain',
      nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
      edges: [],
    })
    expect((await engine.startRun(id)).status).toBe('succeeded')
  })
})
