import { EngineEventSchema, type EngineEvent } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createFakeWorld } from '../src/app/fake-world'
import { fakeData, ids } from '../src/fixtures'

function world(stepIntervalMs = 0) {
  return createFakeWorld({ hostOptions: { restartDelayMs: 0 }, control: { stepIntervalMs } })
}

async function listed(env: ReturnType<typeof world>): Promise<string[]> {
  return (await env.client.request('listWorkflows', {})).workflows.map((entry) => entry.id)
}

describe('fake world deleteWorkflow', () => {
  it('removes the workflow from the list and from getWorkflow, keeps the others, answers an empty result', async () => {
    const env = world()
    const before = await listed(env)
    expect(await env.client.request('deleteWorkflow', { workflowId: ids.workflows.receipt })).toEqual({})
    expect(await listed(env)).toEqual(before.filter((id) => id !== ids.workflows.receipt))
    await expect(env.client.request('getWorkflow', { workflowId: ids.workflows.receipt })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(env.workflowIds().sort()).toEqual(before.filter((id) => id !== ids.workflows.receipt).sort())
    expect(env.callsOf('deleteWorkflow')).toHaveLength(1)
  })

  it('emits one valid workflow.deleted event', async () => {
    const env = world()
    const seen: EngineEvent[] = []
    env.client.onEvent((event) => seen.push(event))
    await env.client.request('deleteWorkflow', { workflowId: ids.workflows.webhook })
    const deleted = seen.filter((event) => event.type === 'workflow.deleted')
    expect(deleted).toEqual([{ type: 'workflow.deleted', at: expect.any(Number), workflowId: ids.workflows.webhook }])
    expect(Value.Check(EngineEventSchema, deleted[0])).toBe(true)
  })

  it('removes the runs of the deleted workflow only', async () => {
    const env = world()
    await env.client.request('deleteWorkflow', { workflowId: ids.workflows.receipt })
    expect((await env.client.request('listRuns', { workflowId: ids.workflows.receipt })).runs).toEqual([])
    const others = fakeData.runs.filter((run) => run.workflowId !== ids.workflows.receipt)
    expect((await env.client.request('listRuns', {})).runs.map((run) => run.id)).toEqual(others.map((run) => run.id))
  })

  it('answers NOT_FOUND for an unknown id and INVALID_PARAMS for bad params, without an event', async () => {
    const env = world()
    const seen: EngineEvent[] = []
    env.client.onEvent((event) => seen.push(event))
    await expect(env.client.request('deleteWorkflow', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(env.client.request('deleteWorkflow', { workflowId: '' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(env.client.request('deleteWorkflow', { workflowId: 'x', force: true } as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(seen).toEqual([])
    expect(await listed(env)).toHaveLength(fakeData.workflows.length)
  })

  it('refuses with WORKFLOW_BUSY while a run is in flight and works once it has finished', async () => {
    const env = world(5)
    await env.client.request('startRun', { workflowId: ids.workflows.receipt })
    await expect(env.client.request('deleteWorkflow', { workflowId: ids.workflows.receipt })).rejects.toMatchObject({ code: 'WORKFLOW_BUSY' })
    expect(await listed(env)).toContain(ids.workflows.receipt)
    await new Promise<void>((resolve) => {
      const off = env.client.onEvent((event) => {
        if (event.type !== 'run.finished') return
        off()
        resolve()
      })
    })
    await env.client.request('deleteWorkflow', { workflowId: ids.workflows.receipt })
    expect(await listed(env)).not.toContain(ids.workflows.receipt)
  })

  it('does not block the delete of another workflow while one runs', async () => {
    const env = world(5)
    await env.client.request('startRun', { workflowId: ids.workflows.receipt })
    await env.client.request('deleteWorkflow', { workflowId: ids.workflows.webhook })
    expect(await listed(env)).not.toContain(ids.workflows.webhook)
  })

  it('lets a plan whose workflow was deleted be deployed again, as the engine does', async () => {
    const env = world()
    const { planId } = await env.client.request('plan', { planId: 'p-again', text: 'x', turns: [], attachments: [], effort: 'medium', useMemory: false })
    const first = (await env.client.request('deployPlan', { planId, confirmed: [] })).workflowId
    await expect(env.client.request('deployPlan', { planId, confirmed: [] })).rejects.toMatchObject({ code: 'PLAN_DEPLOYED' })
    await env.client.request('deleteWorkflow', { workflowId: first })
    const second = (await env.client.request('deployPlan', { planId, confirmed: [] })).workflowId
    expect(second).not.toBe(first)
    expect(await listed(env)).toContain(second)
    await expect(env.client.request('deployPlan', { planId, confirmed: [] })).rejects.toMatchObject({ code: 'PLAN_DEPLOYED' })
  })
})
