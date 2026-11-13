import { EngineEventSchema, flagKey, type EngineEvent, type MethodParams } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createFakeWorld } from '../src/app/fake-world'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods, type FakePlanData } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { metas, models, outcomeOf, results } from '../src/fixtures/plan'

const params = (planId: string): MethodParams<'plan'> => ({ planId, text: 'watch a folder', turns: [], attachments: [], effort: 'medium', useMemory: false })

function plain(extra: Partial<FakePlanData> = {}) {
  const base = createFakeClient(fakeData)
  const client = withPlanMethods(base, { models, script: () => outcomeOf(results.workflow), memory: [], ...extra })
  const seen: EngineEvent[] = []
  client.onEvent((event) => seen.push(event))
  return { client, seen }
}

describe('the fake engine emits plan.deployed like the engine', () => {
  it('emits one valid event for a deploy, with the workflow id and the plan id, and none for a refused deploy', async () => {
    const { client, seen } = plain({ deployId: 'wf-fixed', now: () => 4242 })
    await client.request('plan', params('p'))
    await expect(client.request('deployPlan', { planId: 'unknown', confirmed: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(seen).toEqual([])
    await client.request('deployPlan', { planId: 'p', confirmed: [] })
    expect(seen).toEqual([{ type: 'plan.deployed', at: 4242, workflowId: 'wf-fixed', planId: 'p' }])
    expect(Value.Check(EngineEventSchema, seen[0])).toBe(true)
    await expect(client.request('deployPlan', { planId: 'p', confirmed: [] })).rejects.toMatchObject({ code: 'PLAN_DEPLOYED' })
    expect(seen).toHaveLength(1)
  })

  it('emits nothing for a deploy that needs confirmation and is not confirmed', async () => {
    const flagged = results.flagged
    if (flagged.kind !== 'workflow') throw new Error('workflow expected')
    const { client, seen } = plain({ script: () => ({ result: flagged, meta: metas.plain }) })
    await client.request('plan', params('f'))
    await expect(client.request('deployPlan', { planId: 'f', confirmed: [] })).rejects.toMatchObject({ code: 'PLAN_NOT_CONFIRMED' })
    expect(seen).toEqual([])
    await client.request('deployPlan', { planId: 'f', confirmed: flagged.flags.map(flagKey) })
    expect(seen.map((event) => event.type)).toEqual(['plan.deployed'])
  })

  it('works over a client that cannot emit', async () => {
    const base = createFakeClient(fakeData)
    const client = withPlanMethods({ request: (method, given) => base.request(method, given), onEvent: (listener) => base.onEvent(listener) }, { models, script: () => outcomeOf(results.workflow), memory: [] })
    await client.request('plan', params('p'))
    await expect(client.request('deployPlan', { planId: 'p', confirmed: [] })).resolves.toEqual({ workflowId: expect.any(String) })
  })

  it('emits it once from the fake world, after the workflow is in the list', async () => {
    const env = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, control: { stepIntervalMs: 0 } })
    const seen: EngineEvent[] = []
    const listed: string[][] = []
    env.client.onEvent((event) => {
      if (event.type !== 'plan.deployed') return
      seen.push(event)
      void env.client.request('listWorkflows', {}).then((answer) => listed.push(answer.workflows.map((entry) => entry.id)))
    })
    await env.client.request('plan', params('p-world'))
    const { workflowId } = await env.client.request('deployPlan', { planId: 'p-world', confirmed: [] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual([{ type: 'plan.deployed', at: expect.any(Number), workflowId, planId: 'p-world' }])
    expect(listed).toHaveLength(1)
    expect(listed[0]).toContain(workflowId)
    await expect(env.client.request('deployPlan', { planId: 'p-world', confirmed: [] })).rejects.toMatchObject({ code: 'PLAN_DEPLOYED' })
    expect(seen).toHaveLength(1)
  })
})
