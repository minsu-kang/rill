import { RillClient, type EngineEvent } from '@rill/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'
import { createTestRegistry } from './helpers'
import { waitFor } from './process'

const TOKEN = 'delete-token-0123456789abcdef'

const workflow = (name: string) => ({
  schemaVersion: 1,
  name,
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'n1', type: 'test.echo@1', config: { value: '{{t1.output}}' } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
})

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start() {
  const engine = new Engine({ db: Db.open(':memory:'), registry: createTestRegistry(), sleep: async () => {} })
  const logs: string[] = []
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(async () => {
    await server.close()
    await engine.shutdown()
  })
  const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN)
  cleanups.push(() => client.close())
  const events: EngineEvent[] = []
  client.onEvent((event) => events.push(event))
  return { engine, client, events, logs }
}

describe('deleteWorkflow over the socket', () => {
  it('deletes the workflow, its runs and answers an empty result, and tells every client', async () => {
    const { client, events, engine } = await start()
    const { workflowId } = await client.request('deploy', { workflow: workflow('doomed') })
    const keep = await client.request('deploy', { workflow: workflow('kept') })
    const { runId } = await client.request('startRun', { workflowId, payload: { a: 1 } })
    await waitFor(() => events.some((event) => event.type === 'run.finished'))
    expect((await client.request('listRuns', { workflowId })).runs.map((run) => run.id)).toEqual([runId])

    expect(await client.request('deleteWorkflow', { workflowId })).toEqual({})

    await waitFor(() => events.some((event) => event.type === 'workflow.deleted'))
    expect(events.filter((event) => event.type === 'workflow.deleted')).toEqual([{ type: 'workflow.deleted', at: expect.any(Number), workflowId }])
    expect((await client.request('listWorkflows', {})).workflows.map((entry) => entry.id)).toEqual([keep.workflowId])
    expect((await client.request('listRuns', { workflowId })).runs).toEqual([])
    await expect(client.request('getRun', { runId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.request('getWorkflow', { workflowId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(engine.listWorkflows()).toHaveLength(1)
  })

  it('answers NOT_FOUND for an unknown id', async () => {
    const { client, events } = await start()
    await expect(client.request('deleteWorkflow', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(events.map((event) => event.type)).not.toContain('workflow.deleted')
  })

  it('answers WORKFLOW_BUSY while a run is queued and leaves everything in place', async () => {
    const { client, engine, events, logs } = await start()
    const { workflowId } = await client.request('deploy', { workflow: workflow('busy') })
    engine.store.createRun({ workflowId, payload: {}, dryRun: false })

    await expect(client.request('deleteWorkflow', { workflowId })).rejects.toMatchObject({
      code: 'WORKFLOW_BUSY',
      message: expect.stringContaining('queued or running'),
    })

    expect((await client.request('listWorkflows', {})).workflows).toHaveLength(1)
    expect((await client.request('listRuns', { workflowId })).runs).toHaveLength(1)
    expect(events.map((event) => event.type)).not.toContain('workflow.deleted')
    expect(logs).toEqual([])
  })

  it('rejects an empty id, a missing id and an unknown field before it reaches the engine', async () => {
    const { client, engine } = await start()
    const { workflowId } = await client.request('deploy', { workflow: workflow('safe') })
    for (const params of [{ workflowId: '' }, {}, { workflowId, force: true }]) {
      await expect(client.request('deleteWorkflow', params as never), JSON.stringify(params)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    expect(engine.listWorkflows()).toHaveLength(1)
  })
})
