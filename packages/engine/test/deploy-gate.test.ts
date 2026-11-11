import { createCoreRegistry } from '@rill/nodes-core'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, WorkflowValidationError } from '../src/engine'
import { PlanNotConfirmedError } from '../src/plans'
import {
  FLAGGED_URL,
  ScriptedProvider,
  flaggedWorkflow,
  plainWorkflow,
  planInput,
  questionsReply,
  workflowReply,
  type Step,
} from './plan-helpers'

const engines: Engine[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function setup(steps: Step[] = []) {
  const engine = new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), llm: new ScriptedProvider(steps) })
  engines.push(engine)
  return engine
}

async function plannedFlagged(engine: Engine, planId = 'plan-1') {
  await engine.plan(planInput({ planId, text: 'Post something out' }))
  return engine.getPlan(planId)
}

function reordered(): unknown {
  return {
    edges: [{ to: 'n1', from: 't1' }],
    nodes: [
      { config: {}, type: 'trigger.manual@1', id: 't1' },
      { config: { method: 'POST', url: FLAGGED_URL }, type: 'http.request@1', id: 'n1' },
    ],
    name: 'posts out',
    schemaVersion: 1,
  }
}

async function rejection(action: () => unknown): Promise<unknown> {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

describe('Engine.deploy gate', () => {
  it('refuses the content of a flagged plan, whether identical, reordered or renamed', async () => {
    const engine = setup([{ data: workflowReply(flaggedWorkflow()) }])
    const plan = await plannedFlagged(engine)
    expect(plan.flagKeys.length).toBeGreaterThan(0)
    const renamed = { ...flaggedWorkflow(), name: 'a different name' }
    for (const content of [flaggedWorkflow(), reordered(), renamed]) {
      const error = await rejection(() => engine.deploy(content))
      expect(error).toBeInstanceOf(PlanNotConfirmedError)
      expect((error as Error).message).toContain('plan-1')
      expect((error as Error).message).toContain('deployPlan')
      expect((error as Error).message).not.toContain(FLAGGED_URL)
    }
    expect(engine.listWorkflows()).toEqual([])
  })

  it('lets the same content through once the plan is deployed with its keys', async () => {
    const engine = setup([{ data: workflowReply(flaggedWorkflow()) }])
    const plan = await plannedFlagged(engine)
    const fromPlan = engine.deployPlan('plan-1', plan.flagKeys)
    expect(engine.deploy(flaggedWorkflow())).toBe(fromPlan)
    const renamed = engine.deploy({ ...flaggedWorkflow(), name: 'a different name' })
    expect(engine.getWorkflow(renamed).name).toBe('a different name')
    expect(() => engine.deploy(reordered())).not.toThrow()
  })

  it('never blocks the content of an unflagged plan', async () => {
    const engine = setup([{ data: workflowReply(plainWorkflow()) }])
    await engine.plan(planInput())
    expect(engine.getPlan('plan-1').flagKeys).toEqual([])
    expect(() => engine.deploy(plainWorkflow())).not.toThrow()
  })

  it('never blocks because of a plan that asked questions or failed', async () => {
    const engine = setup([{ data: questionsReply() }])
    await engine.plan(planInput({ planId: 'asks' }))
    await expect(engine.plan(planInput({ planId: 'failed' }))).rejects.toThrow()
    expect(() => engine.deploy(plainWorkflow())).not.toThrow()
    expect(() => engine.deploy(flaggedWorkflow())).not.toThrow()
  })

  it('does not block a workflow whose config differs by one value', async () => {
    const engine = setup([{ data: workflowReply(flaggedWorkflow()) }])
    await plannedFlagged(engine)
    const edited = flaggedWorkflow()
    edited.nodes[1]!.config.url = 'https://elsewhere.invalid/x'
    expect(() => engine.deploy(edited)).not.toThrow()
    const changedMethod = flaggedWorkflow()
    changedMethod.nodes[1]!.config.method = 'PUT'
    expect(() => engine.deploy(changedMethod)).not.toThrow()
    const extraEdge = flaggedWorkflow()
    extraEdge.nodes.push({ id: 'n2', type: 'delay@1', config: { ms: 1 } })
    extraEdge.edges.push({ from: 'n1', to: 'n2' })
    expect(() => engine.deploy(extraEdge)).not.toThrow()
  })

  it('keeps blocking while any plan with the same content is still open', async () => {
    const engine = setup([{ data: workflowReply(flaggedWorkflow()) }, { data: workflowReply(flaggedWorkflow()) }])
    const first = await plannedFlagged(engine, 'first')
    const second = await plannedFlagged(engine, 'second')
    const blocked = (await rejection(() => engine.deploy(flaggedWorkflow()))) as Error
    expect(blocked.message).toMatch(/first|second/)
    engine.deployPlan('second', second.flagKeys)
    const stillBlocked = (await rejection(() => engine.deploy(flaggedWorkflow()))) as Error
    expect(stillBlocked.message).toContain('first')
    engine.deployPlan('first', first.flagKeys)
    expect(() => engine.deploy(flaggedWorkflow())).not.toThrow()
  })

  it('still reports validation problems before looking at plans', async () => {
    const engine = setup([{ data: workflowReply(flaggedWorkflow()) }])
    await plannedFlagged(engine)
    const invalid = flaggedWorkflow()
    invalid.nodes[1]!.config.url = 'ftp://not-http.invalid'
    await expect(Promise.resolve().then(() => engine.deploy(invalid))).rejects.toBeInstanceOf(WorkflowValidationError)
    await expect(Promise.resolve().then(() => engine.deploy({ nope: true }))).rejects.toBeInstanceOf(WorkflowValidationError)
  })

  it('does not apply to deployPlan, which confirms the flags itself', async () => {
    const engine = setup([{ data: workflowReply(flaggedWorkflow()) }])
    const plan = await plannedFlagged(engine)
    expect(() => engine.deployPlan('plan-1', plan.flagKeys)).not.toThrow()
  })
})
