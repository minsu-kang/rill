import { createCoreRegistry } from '@rill/nodes-core'
import { EngineEventSchema } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { PlanDeployedError, PlanNotConfirmedError, PlanNotFoundError } from '../src/plans'
import { ScriptedProvider, flaggedWorkflow, plainWorkflow, planInput, workflowReply, type Step } from './plan-helpers'

const engines: Engine[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function setup(steps: Step[]) {
  const db = Db.open(':memory:')
  const engine = new Engine({ db, registry: createCoreRegistry(), llm: new ScriptedProvider(steps), now: () => 4_000 })
  const events: EngineEvent[] = []
  engine.on((event) => events.push(event))
  engines.push(engine)
  return { engine, db, events }
}

const deployed = (events: EngineEvent[]) => events.filter((event) => event.type === 'plan.deployed')

describe('the plan.deployed event', () => {
  it('is emitted once by deployPlan, with the workflow and the plan, after the workflow is stored', async () => {
    const { engine, events } = setup([{ data: workflowReply(plainWorkflow('shipped')) }])
    const seen: Array<{ stored: boolean; marked: boolean }> = []
    engine.on((event) => {
      if (event.type !== 'plan.deployed') return
      seen.push({ stored: engine.listWorkflows().some((workflow) => workflow.id === event.workflowId), marked: engine.getPlan(event.planId).workflowId === event.workflowId })
    })
    await engine.plan(planInput())
    const workflowId = engine.deployPlan('plan-1', [])
    expect(deployed(events)).toEqual([{ type: 'plan.deployed', at: 4_000, workflowId, planId: 'plan-1' }])
    expect(seen).toEqual([{ stored: true, marked: true }])
  })

  it('matches the protocol schema', async () => {
    const { engine, events } = setup([{ data: workflowReply(plainWorkflow()) }])
    await engine.plan(planInput())
    engine.deployPlan('plan-1', [])
    expect(deployed(events)).toHaveLength(1)
    for (const event of events) expect(Value.Check(EngineEventSchema, event), JSON.stringify(event)).toBe(true)
  })

  it('is emitted after a confirmed flagged plan, once, and not for a second call', async () => {
    const { engine, events } = setup([{ data: workflowReply(flaggedWorkflow()) }])
    await engine.plan(planInput())
    const keys = engine.getPlan('plan-1').flagKeys
    expect(() => engine.deployPlan('plan-1', [])).toThrow(PlanNotConfirmedError)
    expect(deployed(events)).toHaveLength(0)
    engine.deployPlan('plan-1', keys)
    expect(() => engine.deployPlan('plan-1', keys)).toThrow(PlanDeployedError)
    expect(deployed(events)).toHaveLength(1)
  })

  it('is not emitted by a deploy that fails, for any reason', async () => {
    const { engine, events } = setup([{ data: workflowReply(flaggedWorkflow()) }, { data: { kind: 'unsupported', reason: 'no', nearest: 'x', summary: 'no' } }])
    expect(() => engine.deployPlan('missing', [])).toThrow(PlanNotFoundError)
    await engine.plan(planInput({ planId: 'flagged' }))
    expect(() => engine.deployPlan('flagged', ['wrong'])).toThrow(PlanNotConfirmedError)
    await engine.plan(planInput({ planId: 'refused' })).catch(() => undefined)
    expect(() => engine.deployPlan('refused', [])).toThrow()
    expect(deployed(events)).toEqual([])
  })

  it('is not emitted by deploy, activation or a run', async () => {
    const { engine, events } = setup([])
    const id = engine.deploy(plainWorkflow('direct'))
    await engine.startRun(id, {})
    expect(deployed(events)).toEqual([])
  })

  it('is emitted for a plan whose workflow is already stored, because the plan is what was deployed', async () => {
    const { engine, events } = setup([{ data: workflowReply(plainWorkflow('same')) }])
    const existing = engine.deploy(plainWorkflow('same'))
    await engine.plan(planInput())
    expect(engine.deployPlan('plan-1', [])).toBe(existing)
    expect(deployed(events)).toEqual([{ type: 'plan.deployed', at: 4_000, workflowId: existing, planId: 'plan-1' }])
  })

  it('does not stop the deploy when a listener throws', async () => {
    const { engine } = setup([{ data: workflowReply(plainWorkflow()) }])
    engine.on(() => {
      throw new Error('listener broke')
    })
    await engine.plan(planInput())
    expect(engine.deployPlan('plan-1', [])).toBeTypeOf('string')
  })
})
