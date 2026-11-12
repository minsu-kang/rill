// @vitest-environment node
import { isTrigger } from '@rill/dsl'
import { createCoreRegistry, validateWorkflow } from '@rill/nodes-core'
import { EngineEventSchema, METHODS, type EngineEvent, type StepDetail } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { fakeData, FIXTURE_NOW, ids, workflows } from '../src/fixtures'
import { hostileValue } from '../src/fixtures/hostile'
import { largeStates, largeWorkflow } from '../src/fixtures/large'
import { branchingEvents, failingReceiptEvents, liveFakeData, liveIds } from '../src/fixtures/live'
import { reduceEvent } from '../src/model/reduce-events'
import { NO_STATES } from '../src/model/status'

const registry = createCoreRegistry()
const STRICT = { registry, allowedRoots: ['/Users/demo'], connections: ['slack-ops'] }

function deepest(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth
  return Math.max(depth, ...Object.values(value).map((inner) => deepest(inner, depth + 1)))
}

function longest(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === null || typeof value !== 'object') return 0
  return Math.max(0, ...Object.values(value).map(longest))
}

function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value)
  else if (value !== null && typeof value === 'object') for (const inner of Object.values(value)) strings(inner, found)
  return found
}

describe('fixture workflows', () => {
  it('has the three workflows the stories need', () => {
    expect(fakeData.workflows.map((w) => w.id)).toEqual([ids.workflows.receipt, ids.workflows.branching, ids.workflows.webhook])
    expect(workflows.receipt.nodes.map((n) => n.type)).toEqual(['trigger.folderWatch@1', 'llm.extract@1', 'csv.append@1'])
    expect(new Set(workflows.branching.nodes.map((n) => n.type))).toEqual(
      new Set(['trigger.cron@1', 'http.request@1', 'condition@1', 'notify.slack@1', 'csv.append@1']),
    )
    expect(workflows.branching.edges.filter((e) => e.when !== undefined).map((e) => e.when).sort()).toEqual(['false', 'true'])
    expect(workflows.webhook.nodes[0]?.type).toBe('trigger.webhook@1')
  })

  it('pass the shared validator with the real registry', () => {
    for (const { id, workflow } of fakeData.workflows) {
      expect(validateWorkflow(workflow, { registry }), id).toEqual([])
      expect(validateWorkflow(workflow, STRICT), id).toEqual([])
    }
  })

  it('pass the protocol result schema', () => {
    for (const { id } of fakeData.workflows) {
      const found = fakeData.workflows.find((w) => w.id === id)!
      expect(Value.Check(METHODS.getWorkflow.result, { workflow: found.workflow }), id).toBe(true)
    }
  })

  it('have unique ids and names', () => {
    expect(new Set(fakeData.workflows.map((w) => w.id)).size).toBe(fakeData.workflows.length)
    expect(new Set(fakeData.workflows.map((w) => w.workflow.name)).size).toBe(fakeData.workflows.length)
  })
})

describe('fixture runs', () => {
  const byId = new Map(fakeData.workflows.map((w) => [w.id, w.workflow]))

  it('belong to a fixture workflow and have unique ids', () => {
    expect(new Set(fakeData.runs.map((r) => r.id)).size).toBe(fakeData.runs.length)
    for (const run of fakeData.runs) expect(byId.has(run.workflowId), run.id).toBe(true)
  })

  it('pass the protocol result schemas', () => {
    expect(Value.Check(METHODS.listRuns.result, { runs: fakeData.runs })).toBe(true)
    for (const run of fakeData.runs) {
      expect(Value.Check(METHODS.getRun.result, { run, steps: fakeData.steps[run.id] ?? [] }), run.id).toBe(true)
    }
  })

  it('only have steps for nodes of their own workflow, and none for a trigger', () => {
    for (const run of fakeData.runs) {
      const workflow = byId.get(run.workflowId)!
      const ids = new Map(workflow.nodes.map((n) => [n.id, n]))
      for (const step of fakeData.steps[run.id] ?? []) {
        const node = ids.get(step.nodeId)
        expect(node, `${run.id} ${step.nodeId}`).toBeDefined()
        expect(isTrigger(node!.type), `${run.id} ${step.nodeId}`).toBe(false)
      }
    }
    for (const runId of Object.keys(fakeData.steps)) expect(fakeData.runs.some((r) => r.id === runId), runId).toBe(true)
  })

  it('number the attempts of a node from 1 without gaps and finish a step unless it runs', () => {
    for (const run of fakeData.runs) {
      const attempts = new Map<string, StepDetail[]>()
      for (const step of fakeData.steps[run.id] ?? []) attempts.set(step.nodeId, [...(attempts.get(step.nodeId) ?? []), step])
      for (const [nodeId, rows] of attempts) {
        expect(rows.map((r) => r.attempt), `${run.id} ${nodeId}`).toEqual(rows.map((_, index) => index + 1))
        for (const row of rows) {
          expect(row.finishedAt === null, `${run.id} ${nodeId}`).toBe(row.status === 'running')
          if (row.finishedAt !== null) expect(row.finishedAt).toBeGreaterThanOrEqual(row.startedAt)
          expect(row.error !== null, `${run.id} ${nodeId} ${row.status}`).toBe(row.status === 'failed' || row.status === 'continued')
        }
      }
    }
  })

  it('cover all six step statuses and all five run statuses', () => {
    const stepStatuses = new Set(Object.values(fakeData.steps).flat().map((s) => s.status))
    expect([...stepStatuses].sort()).toEqual(['abandoned', 'continued', 'failed', 'running', 'skipped', 'succeeded'])
    expect([...new Set(fakeData.runs.map((r) => r.status))].sort()).toEqual(['cancelled', 'failed', 'queued', 'running', 'succeeded'])
    expect(fakeData.runs.some((r) => r.dryRun)).toBe(true)
  })

  it('include a failed run with a long error and a step that retried', () => {
    const run = fakeData.runs.find((r) => r.id === ids.runs.receiptFailed)!
    expect(run.status).toBe('failed')
    expect(run.error!.length).toBeGreaterThan(300)
    const rows = fakeData.steps[run.id]!.filter((s) => s.nodeId === 'extract')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.at(-1)!.error!.length).toBeGreaterThan(300)
  })

  it('include a run with a skipped branch and one with a continued step', () => {
    const skipped = fakeData.steps[ids.runs.branchingSkipped]!
    expect(skipped.some((s) => s.status === 'skipped')).toBe(true)
    expect(skipped.some((s) => s.status === 'succeeded')).toBe(true)
    expect(fakeData.steps[ids.runs.branchingContinued]!.some((s) => s.status === 'continued')).toBe(true)
  })

  it('include a run whose data is hostile', () => {
    const rows = fakeData.steps[ids.runs.receiptHostile]!
    const data = rows.flatMap((row) => [row.input, row.output])
    const text = data.flatMap((value) => strings(value))
    expect(text.some((s) => s.includes('<script>'))).toBe(true)
    expect(text.some((s) => /<img[^>]*onerror/i.test(s))).toBe(true)
    expect(Math.max(...data.map(longest))).toBeGreaterThanOrEqual(50_000)
    expect(Math.max(...data.map((value) => deepest(value)))).toBeGreaterThanOrEqual(30)
    const hostile = hostileValue() as { big: unknown[] }
    expect(hostile.big).toHaveLength(10_000)
  })

  it('use times around the fixed fixture clock', () => {
    for (const run of fakeData.runs) {
      expect(run.createdAt).toBeLessThanOrEqual(FIXTURE_NOW)
      expect(FIXTURE_NOW - run.createdAt).toBeLessThan(10 * 24 * 3_600_000)
    }
  })
})

describe('fixture catalog', () => {
  it('describes every node type the fixture workflows use', () => {
    const types = new Set(fakeData.catalog.map((n) => n.type))
    for (const { workflow } of fakeData.workflows) for (const node of workflow.nodes) expect(types.has(node.type), node.type).toBe(true)
  })

  it('passes the protocol result schema', () => {
    expect(Value.Check(METHODS.nodeCatalog.result, { nodes: fakeData.catalog })).toBe(true)
  })
})

describe('large generated workflow', () => {
  it('has thirty nodes, passes the shared validator and has labelled branches', () => {
    const workflow = largeWorkflow()
    expect(workflow.nodes).toHaveLength(30)
    expect(new Set(workflow.nodes.map((n) => n.id)).size).toBe(30)
    expect(validateWorkflow(workflow, { registry, allowedRoots: ['/Users/demo'], connections: ['slack-ops'] })).toEqual([])
    expect(workflow.edges.filter((e) => e.when === 'true')).toHaveLength(workflow.edges.filter((e) => e.when === 'false').length)
  })

  it('gives every node of the workflow a state that mixes all the statuses', () => {
    const workflow = largeWorkflow()
    const states = largeStates(workflow)
    const statuses = new Set(Object.values(states).map((s) => s.status))
    for (const status of ['running', 'succeeded', 'failed', 'skipped', 'continued']) expect(statuses.has(status as never), status).toBe(true)
    for (const key of Object.keys(states)) expect(workflow.nodes.some((n) => n.id === key), key).toBe(true)
  })
})

describe('live event scripts', () => {
  const scripts = [
    ['branching', liveIds.branching, branchingEvents(liveIds.branching), 'wf-branching'],
    ['failing receipt', liveIds.receiptFails, failingReceiptEvents(liveIds.receiptFails), 'wf-receipt'],
  ] as const

  it('are valid engine events of their own run', () => {
    for (const [name, runId, events] of scripts) {
      expect(events.length, name).toBeGreaterThan(5)
      for (const event of events) {
        expect(Value.Check(EngineEventSchema, event), `${name} ${event.type}`).toBe(true)
        if ('runId' in event) expect(event.runId).toBe(runId)
      }
      expect(events[0]?.type).toBe('run.started')
      expect(events.at(-1)?.type).toBe('run.finished')
    }
  })

  it('end in the states a person should see, through the same reducer the hooks use', () => {
    const finalStates = (runId: string, events: readonly EngineEvent[]) => events.reduce((states, event) => reduceEvent(states, event, runId), NO_STATES)
    const branching = finalStates(liveIds.branching, branchingEvents(liveIds.branching))
    expect(Object.values(branching).map((s) => s.status).sort()).toEqual(['continued', 'skipped', 'succeeded', 'succeeded'])
    const failing = finalStates(liveIds.receiptFails, failingReceiptEvents(liveIds.receiptFails))
    expect(failing.extract).toMatchObject({ status: 'failed', attempt: 3 })
  })

  it('belong to a run that the live fake data lists as running and that has no steps yet', () => {
    const data = liveFakeData()
    for (const [, runId, , workflowId] of scripts) {
      const found = data.runs.find((r) => r.id === runId)!
      expect(found).toMatchObject({ workflowId, status: 'running', finishedAt: null })
      expect(Value.Check(METHODS.listRuns.result, { runs: data.runs })).toBe(true)
      expect(data.steps[runId]).toBeUndefined()
    }
  })
})
