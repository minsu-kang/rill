import type { Workflow, WorkflowEdge, WorkflowNode } from '@rill/dsl'
import { createCoreRegistry } from '@rill/nodes-core'
import type { ExplainRun, ExplainRunInput, ExplainStep } from '../../src/index'

export const registry = createCoreRegistry()

export const SECRET = 'SECRET-MARKER-7f3a9c'

export function node(id: string, type: string, config: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type, config, ...extra }
}

export function edge(from: string, to: string, when?: string): WorkflowEdge {
  return when === undefined ? { from, to } : { from, to, when }
}

export function workflowOf(nodes: WorkflowNode[], edges: WorkflowEdge[], name = 'Nightly sync'): Workflow {
  return { schemaVersion: 1, name, nodes, edges }
}

export function chain(): Workflow {
  return workflowOf(
    [
      node('t1', 'trigger.manual@1'),
      node('n1', 'http.request@1', { url: 'https://api.example.com/orders', method: 'GET' }),
      node('n2', 'csv.append@1', { file: '/data/ledger.csv', row: ['{{n1.output.status}}'] }),
    ],
    [edge('t1', 'n1'), edge('n1', 'n2')],
  )
}

export function step(nodeId: string, status: ExplainStep['status'], overrides: Partial<ExplainStep> = {}): ExplainStep {
  return { nodeId, attempt: 1, status, input: {}, output: null, error: null, startedAt: 1000, finishedAt: 1100, ...overrides }
}

export function runOf(overrides: Partial<ExplainRun> = {}): ExplainRun {
  return { id: 'run-1', status: 'failed', dryRun: false, error: 'node n1 failed: HTTP 500', createdAt: 900, startedAt: 1000, finishedAt: 1340, ...overrides }
}

export function inputOf(overrides: Partial<ExplainRunInput> = {}): ExplainRunInput {
  return {
    run: runOf(),
    steps: [step('n1', 'failed', { error: 'HTTP 500' })],
    workflow: chain(),
    registry,
    secrets: [],
    ...overrides,
  }
}

export function allText(value: unknown): string {
  return JSON.stringify(value)
}
