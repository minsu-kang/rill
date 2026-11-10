import { createCoreRegistry, defineAction, type ConnectionResolver, type NodeContext } from '@rill/nodes-core'
import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { linearWorkflow } from './helpers'

function setup(options: { allowedRoots?: string[]; connections?: ConnectionResolver } = {}) {
  const captured: NodeContext[] = []
  const sleeps: number[] = []
  const registry = createCoreRegistry().register(
    defineAction({
      type: 'test.ctx@1',
      title: 'Ctx',
      description: 'Captures its context.',
      sideEffect: 'none',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({}),
      execute: async (_config, ctx) => {
        captured.push(ctx)
        return {}
      },
    }),
  )
  const engine = new Engine({
    db: Db.open(':memory:'),
    registry,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...options,
  })
  const workflow = linearWorkflow([
    { id: 't1', type: 'trigger.manual@1' },
    { id: 'n1', type: 'test.ctx@1' },
  ])
  return { engine, workflowId: engine.deploy(workflow), captured, sleeps }
}

describe('node context services', () => {
  it('hands nodes the engine sleep function', async () => {
    const { engine, workflowId, captured, sleeps } = setup()
    await engine.startRun(workflowId)
    await captured[0]!.sleep(250)
    expect(sleeps).toEqual([250])
  })

  it('is unrestricted by default and passes allowedRoots through when set', async () => {
    const open = setup()
    await open.engine.startRun(open.workflowId)
    expect(open.captured[0]!.allowedRoots).toBeUndefined()

    const closed = setup({ allowedRoots: ['/data'] })
    await closed.engine.startRun(closed.workflowId)
    expect(closed.captured[0]!.allowedRoots).toEqual(['/data'])
  })

  it('exposes connections, and an empty resolver by default', async () => {
    const none = setup()
    await none.engine.startRun(none.workflowId)
    expect(none.captured[0]!.connections.get('slack')).toBeUndefined()

    const some = setup({ connections: { get: (id) => (id === 'slack' ? 'https://example.test/hook' : undefined) } })
    await some.engine.startRun(some.workflowId)
    expect(some.captured[0]!.connections.get('slack')).toBe('https://example.test/hook')
  })
})
