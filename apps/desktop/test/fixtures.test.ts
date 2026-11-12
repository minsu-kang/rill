// @vitest-environment node
import { isTrigger } from '@rill/dsl'
import { createCoreRegistry, validateWorkflow } from '@rill/nodes-core'
import { METHODS, type StepDetail } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { fakeData, FIXTURE_NOW, ids, workflows } from '../src/fixtures'
import { hostileValue } from '../src/fixtures/hostile'

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
