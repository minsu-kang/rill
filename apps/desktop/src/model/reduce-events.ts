import type { EngineEvent, RunSummary } from '@rill/protocol'
import { NO_STATES, stateOf, withState, type RunStates } from './status'

export function reduceEvent(states: RunStates, event: EngineEvent, runId: string): RunStates {
  switch (event.type) {
    case 'run.started':
      return event.runId === runId && Object.keys(states).length > 0 ? NO_STATES : states
    case 'step.started': {
      if (event.runId !== runId) return states
      const previous = stateOf(states, event.nodeId)
      if (previous !== undefined && previous.attempt >= event.attempt) return states
      const retrying = event.attempt > 1
      return withState(states, event.nodeId, {
        status: 'running',
        attempt: event.attempt,
        retrying,
        error: retrying ? (previous?.error ?? null) : null,
      })
    }
    case 'step.succeeded': {
      if (event.runId !== runId) return states
      if ((stateOf(states, event.nodeId)?.attempt ?? 0) > event.attempt) return states
      return withState(states, event.nodeId, { status: 'succeeded', attempt: event.attempt, retrying: false, error: null })
    }
    case 'step.failed': {
      if (event.runId !== runId) return states
      if ((stateOf(states, event.nodeId)?.attempt ?? 0) > event.attempt) return states
      return withState(
        states,
        event.nodeId,
        event.willRetry
          ? { status: 'running', attempt: event.attempt, retrying: true, error: event.error }
          : { status: 'failed', attempt: event.attempt, retrying: false, error: event.error },
      )
    }
    case 'step.skipped': {
      if (event.runId !== runId || stateOf(states, event.nodeId) !== undefined) return states
      return withState(states, event.nodeId, { status: 'skipped', attempt: 1, retrying: false, error: null })
    }
    case 'step.continued': {
      if (event.runId !== runId) return states
      if ((stateOf(states, event.nodeId)?.attempt ?? 0) > event.attempt) return states
      return withState(states, event.nodeId, { status: 'continued', attempt: event.attempt, retrying: false, error: event.error })
    }
    default:
      return states
  }
}

export function reduceRunSummary(run: RunSummary, event: EngineEvent): RunSummary {
  switch (event.type) {
    case 'run.started':
      return event.runId === run.id
        ? { ...run, status: 'running', dryRun: event.dryRun, startedAt: event.at, finishedAt: null, error: null }
        : run
    case 'run.finished':
      return event.runId === run.id ? { ...run, status: event.status, error: event.error, finishedAt: event.at } : run
    default:
      return run
  }
}
