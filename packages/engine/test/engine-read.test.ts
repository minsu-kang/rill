import { createCoreRegistry } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { NotFoundError } from '../src/store'
import { createTestEngine, linearWorkflow } from './helpers'

const trigger = { id: 't1', type: 'trigger.manual@1' }

describe('Engine read APIs', () => {
  it('lists workflows with their trigger type and active flag', async () => {
    const { engine } = createTestEngine()
    const manual = engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: { value: 1 } }]))
    const cron = engine.deploy({
      schemaVersion: 1,
      name: 'cron',
      nodes: [{ id: 't1', type: 'trigger.cron@1', config: { expression: '* * * * *', timezone: 'utc' } }],
      edges: [],
    })
    engine.store.setWorkflowActive(cron, true)
    expect(engine.listWorkflows().map((w) => [w.id, w.name, w.triggerType, w.active])).toEqual([
      [manual, 'test', 'trigger.manual@1', false],
      [cron, 'cron', 'trigger.cron@1', true],
    ])
  })

  it('returns a stored workflow or throws NotFoundError', () => {
    const { engine } = createTestEngine()
    const wf = linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: { value: 1 } }])
    const id = engine.deploy(wf)
    expect(engine.getWorkflow(id)).toMatchObject({ name: 'test', nodes: expect.any(Array) })
    expect(() => engine.getWorkflow('nope')).toThrow(NotFoundError)
  })

  it('reports a stored workflow without a trigger as unknown', () => {
    const { engine } = createTestEngine()
    engine.store.saveWorkflow({
      schemaVersion: 1,
      name: 'bare',
      nodes: [{ id: 'a', type: 'test.echo@1', config: { value: 1 } }],
      edges: [],
    })
    expect(engine.listWorkflows().map((w) => [w.name, w.triggerType])).toEqual([['bare', 'unknown']])
  })

  it('lists runs newest first and clamps the limit', async () => {
    const { engine } = createTestEngine()
    const id = engine.deploy(linearWorkflow([trigger]))
    const results = []
    for (let i = 0; i < 3; i += 1) results.push(await engine.startRun(id, { n: i }))
    expect(engine.listRuns({}).map((r) => r.id)).toEqual(results.map((r) => r.runId).reverse())
    expect(engine.listRuns({ limit: 2 })).toHaveLength(2)
    expect(engine.listRuns({ limit: 0 })).toHaveLength(1)
    expect(engine.listRuns({ limit: 100_000 })).toHaveLength(3)
    expect(engine.listRuns({ limit: 1.5 })).toHaveLength(1)
    expect(engine.listRuns({ limit: Number.NaN })).toHaveLength(3)
    expect(engine.listRuns({ workflowId: 'other' })).toEqual([])
  })

  it('returns a run with the input and output of every step', async () => {
    const { engine } = createTestEngine()
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: { value: '{{t1.output.amount}}' } }]),
    )
    const result = await engine.startRun(id, { amount: 12 })
    const detail = engine.getRunDetail(result.runId)
    expect(detail.run).toMatchObject({ id: result.runId, status: 'succeeded', workflowId: id })
    expect(detail.steps).toHaveLength(1)
    expect(detail.steps[0]).toMatchObject({
      nodeId: 'a',
      attempt: 1,
      status: 'succeeded',
      input: { value: 12 },
      output: { value: 12 },
    })
    expect(() => engine.getRunDetail('nope')).toThrow(NotFoundError)
  })

  it('describes every registered node for editors and planners', () => {
    const engine = new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry() })
    const nodes = engine.nodeCatalog()
    const byType = new Map(nodes.map((n) => [n.type, n]))
    expect(nodes.map((n) => n.type)).toEqual(createCoreRegistry().list().map((d) => d.type))
    expect(byType.get('trigger.cron@1')).toMatchObject({ kind: 'trigger', title: 'Schedule' })
    expect(byType.get('trigger.cron@1')?.sideEffect).toBeUndefined()
    expect(byType.get('csv.append@1')).toMatchObject({ kind: 'action', sideEffect: 'idempotent' })
    expect(byType.get('http.request@1')).toMatchObject({ kind: 'action', sideEffect: 'external' })
    for (const node of nodes) {
      expect(JSON.parse(JSON.stringify(node.configSchema))).toMatchObject({ type: 'object' })
      expect(JSON.parse(JSON.stringify(node.outputSchema))).toBeTruthy()
    }
  })
})
