import type { RunSummary, StepDetail } from '@rill/protocol'
import { NO_STATES, type NodeRunState, type RunStates } from './status'

function stateOfRow(row: StepDetail, runStatus: RunSummary['status'] | undefined): NodeRunState {
  if (row.status === 'failed' && runStatus === 'running') return { status: 'running', attempt: row.attempt, retrying: true, error: row.error }
  return { status: row.status, attempt: row.attempt, retrying: row.status === 'running' && row.attempt > 1, error: row.error }
}

export function statesFromSteps(steps: readonly StepDetail[], runStatus?: RunSummary['status']): RunStates {
  const last = new Map<string, StepDetail>()
  for (const row of steps) {
    const current = last.get(row.nodeId)
    if (current === undefined || row.attempt >= current.attempt) last.set(row.nodeId, row)
  }
  if (last.size === 0) return NO_STATES
  const states: Record<string, NodeRunState> = Object.create(null) as Record<string, NodeRunState>
  for (const [nodeId, row] of last) states[nodeId] = stateOfRow(row, runStatus)
  return Object.freeze(states)
}
