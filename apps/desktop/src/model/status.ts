export const NODE_STATUSES = ['idle', 'running', 'succeeded', 'failed', 'abandoned', 'skipped', 'continued'] as const

export type NodeStatus = (typeof NODE_STATUSES)[number]

export interface NodeRunState {
  status: NodeStatus
  attempt: number
  retrying: boolean
  error: string | null
}

export type RunStates = Readonly<Record<string, NodeRunState>>

export const NO_STATES: RunStates = Object.freeze(Object.create(null) as Record<string, NodeRunState>)

export function stateOf(states: RunStates, nodeId: string): NodeRunState | undefined {
  return Object.hasOwn(states, nodeId) ? states[nodeId] : undefined
}

export function withState(states: RunStates, nodeId: string, state: NodeRunState): RunStates {
  const next: Record<string, NodeRunState> = Object.assign(Object.create(null) as Record<string, NodeRunState>, states)
  next[nodeId] = state
  return Object.freeze(next)
}

export type RunStatusName = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export function visualStatusOfRun(status: RunStatusName): NodeStatus {
  switch (status) {
    case 'queued':
      return 'idle'
    case 'cancelled':
      return 'abandoned'
    default:
      return status
  }
}
