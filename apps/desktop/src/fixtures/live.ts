import type { EngineEvent, RunSummary } from '@rill/protocol'
import type { FakeData } from '../engine/fake-client'
import { fakeData, FIXTURE_NOW, ids } from './index'

export const liveIds = { branching: 'run-live-branching', receiptFails: 'run-live-receipt' } as const

const at = (second: number): number => FIXTURE_NOW + second * 1_000

function liveRun(id: string, workflowId: string): RunSummary {
  return { id, workflowId, status: 'running', dryRun: false, error: null, createdAt: at(0), startedAt: at(0), finishedAt: null }
}

export function liveFakeData(): FakeData {
  return {
    ...fakeData,
    runs: [liveRun(liveIds.branching, ids.workflows.branching), liveRun(liveIds.receiptFails, ids.workflows.receipt), ...fakeData.runs],
  }
}

export function branchingEvents(runId: string): EngineEvent[] {
  const workflowId = ids.workflows.branching
  return [
    { type: 'run.started', at: at(0), runId, workflowId, dryRun: false },
    { type: 'step.started', at: at(1), runId, nodeId: 'check', attempt: 1 },
    { type: 'step.failed', at: at(2), runId, nodeId: 'check', attempt: 1, error: 'request timed out after 15000 ms', willRetry: true },
    { type: 'step.started', at: at(3), runId, nodeId: 'check', attempt: 2 },
    { type: 'step.continued', at: at(4), runId, nodeId: 'check', attempt: 2, error: 'request timed out after 15000 ms' },
    { type: 'step.started', at: at(5), runId, nodeId: 'healthy', attempt: 1 },
    { type: 'step.succeeded', at: at(6), runId, nodeId: 'healthy', attempt: 1 },
    { type: 'step.skipped', at: at(6), runId, nodeId: 'log' },
    { type: 'step.started', at: at(7), runId, nodeId: 'alert', attempt: 1 },
    { type: 'step.succeeded', at: at(8), runId, nodeId: 'alert', attempt: 1 },
    { type: 'run.finished', at: at(9), runId, status: 'succeeded', error: null },
  ]
}

export function failingReceiptEvents(runId: string): EngineEvent[] {
  const workflowId = ids.workflows.receipt
  const error = 'provider error: 503 Service Unavailable'
  return [
    { type: 'run.started', at: at(0), runId, workflowId, dryRun: false },
    { type: 'step.started', at: at(1), runId, nodeId: 'extract', attempt: 1 },
    { type: 'step.failed', at: at(2), runId, nodeId: 'extract', attempt: 1, error, willRetry: true },
    { type: 'step.started', at: at(3), runId, nodeId: 'extract', attempt: 2 },
    { type: 'step.failed', at: at(4), runId, nodeId: 'extract', attempt: 2, error, willRetry: true },
    { type: 'step.started', at: at(5), runId, nodeId: 'extract', attempt: 3 },
    { type: 'step.failed', at: at(6), runId, nodeId: 'extract', attempt: 3, error, willRetry: false },
    { type: 'step.skipped', at: at(6), runId, nodeId: 'append' },
    { type: 'run.finished', at: at(7), runId, status: 'failed', error: `node extract failed: ${error}` },
  ]
}
