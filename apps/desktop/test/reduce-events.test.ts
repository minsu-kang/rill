import type { EngineEvent, RunSummary } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { NO_STATES, stateOf, type NodeRunState, type RunStates } from '../src/model/status'
import { reduceEvent, reduceRunSummary } from '../src/model/reduce-events'

const RUN = 'run-1'
const at = 5000

function apply(events: EngineEvent[], start: RunStates = NO_STATES): RunStates {
  return events.reduce((states, event) => reduceEvent(states, event, RUN), start)
}

const started = (nodeId: string, attempt = 1): EngineEvent => ({ type: 'step.started', at, runId: RUN, nodeId, attempt })
const succeeded = (nodeId: string, attempt = 1): EngineEvent => ({ type: 'step.succeeded', at, runId: RUN, nodeId, attempt })
const failed = (nodeId: string, attempt: number, willRetry: boolean, error = 'boom'): EngineEvent => ({ type: 'step.failed', at, runId: RUN, nodeId, attempt, error, willRetry })

describe('reduceEvent', () => {
  it('starts a step as running with its attempt', () => {
    expect(stateOf(apply([started('a')]), 'a')).toEqual({ status: 'running', attempt: 1, retrying: false, error: null })
  })

  it('marks a step that succeeded', () => {
    expect(stateOf(apply([started('a'), succeeded('a')]), 'a')).toEqual({ status: 'succeeded', attempt: 1, retrying: false, error: null })
  })

  it('marks a step that failed for good with its error', () => {
    expect(stateOf(apply([started('a'), failed('a', 1, false, 'HTTP 500')]), 'a')).toEqual({ status: 'failed', attempt: 1, retrying: false, error: 'HTTP 500' })
  })

  it('keeps a step running and marks it retrying when the failure will be retried', () => {
    const states = apply([started('a'), failed('a', 1, true, 'HTTP 503')])
    expect(stateOf(states, 'a')).toEqual({ status: 'running', attempt: 1, retrying: true, error: 'HTTP 503' })
  })

  it('keeps the retry mark and the last error while the next attempt runs', () => {
    const states = apply([started('a'), failed('a', 1, true, 'HTTP 503'), started('a', 2)])
    expect(stateOf(states, 'a')).toEqual({ status: 'running', attempt: 2, retrying: true, error: 'HTTP 503' })
  })

  it('clears the retry mark and the error when a retry succeeds', () => {
    const states = apply([started('a'), failed('a', 1, true), started('a', 2), succeeded('a', 2)])
    expect(stateOf(states, 'a')).toEqual({ status: 'succeeded', attempt: 2, retrying: false, error: null })
  })

  it('fails for good when the last allowed retry fails', () => {
    const states = apply([started('a'), failed('a', 1, true), started('a', 2), failed('a', 2, false, 'last')])
    expect(stateOf(states, 'a')).toEqual({ status: 'failed', attempt: 2, retrying: false, error: 'last' })
  })

  it('marks a skipped step', () => {
    const states = apply([{ type: 'step.skipped', at, runId: RUN, nodeId: 'a' }])
    expect(stateOf(states, 'a')).toEqual({ status: 'skipped', attempt: 1, retrying: false, error: null })
  })

  it('marks a continued step with its error', () => {
    const states = apply([started('a'), failed('a', 1, false), { type: 'step.continued', at, runId: RUN, nodeId: 'a', attempt: 1, error: 'ignored' }])
    expect(stateOf(states, 'a')).toEqual({ status: 'continued', attempt: 1, retrying: false, error: 'ignored' })
  })

  it('resets everything when the run starts', () => {
    const states = apply([started('a'), succeeded('a'), { type: 'run.started', at, runId: RUN, workflowId: 'w', dryRun: false }])
    expect(Object.keys(states)).toEqual([])
  })

  it('does not invent states when the run finishes', () => {
    const before = apply([started('a'), succeeded('a')])
    for (const status of ['succeeded', 'failed'] as const) {
      const after = reduceEvent(before, { type: 'run.finished', at, runId: RUN, status, error: status === 'failed' ? 'x' : null }, RUN)
      expect(after).toBe(before)
      expect(Object.keys(after)).toEqual(['a'])
    }
  })

  it('ignores every event of another run', () => {
    const before = apply([started('a')])
    const other: EngineEvent[] = [
      { type: 'run.started', at, runId: 'run-2', workflowId: 'w', dryRun: false },
      { type: 'step.started', at, runId: 'run-2', nodeId: 'b', attempt: 1 },
      { type: 'step.succeeded', at, runId: 'run-2', nodeId: 'a', attempt: 1 },
      { type: 'step.failed', at, runId: 'run-2', nodeId: 'a', attempt: 1, error: 'x', willRetry: false },
      { type: 'step.skipped', at, runId: 'run-2', nodeId: 'c' },
      { type: 'step.continued', at, runId: 'run-2', nodeId: 'a', attempt: 1, error: 'x' },
      { type: 'run.finished', at, runId: 'run-2', status: 'failed', error: 'x' },
    ]
    for (const event of other) expect(reduceEvent(before, event, RUN)).toBe(before)
  })

  it('ignores events that carry no step information', () => {
    const before = apply([started('a')])
    const events: EngineEvent[] = [
      { type: 'trigger.fired', at, workflowId: 'w', runId: RUN },
      { type: 'trigger.skipped', at, workflowId: 'w', reason: 'busy' },
      { type: 'trigger.error', at, workflowId: 'w', error: 'x' },
      { type: 'workflow.activated', at, workflowId: 'w' },
      { type: 'workflow.deactivated', at, workflowId: 'w' },
    ]
    for (const event of events) expect(reduceEvent(before, event, RUN)).toBe(before)
  })

  it('does not go back when an older event arrives after a newer state', () => {
    const states = apply([started('a'), failed('a', 1, true), started('a', 2), succeeded('a', 2)])
    expect(reduceEvent(states, started('a', 1), RUN)).toBe(states)
    expect(reduceEvent(states, started('a', 2), RUN)).toBe(states)
    expect(reduceEvent(states, failed('a', 1, true), RUN)).toBe(states)
    expect(reduceEvent(states, { type: 'step.skipped', at, runId: RUN, nodeId: 'a' }, RUN)).toBe(states)
  })

  it('does not change the states it was given', () => {
    const before = apply([started('a'), succeeded('a')])
    const snapshot = structuredClone({ ...before })
    const after = reduceEvent(before, started('b'), RUN)
    expect(after).not.toBe(before)
    expect({ ...before }).toEqual(snapshot)
    expect(stateOf(before, 'b')).toBeUndefined()
    expect(Object.isFrozen(after)).toBe(true)
  })

  it('keeps nodes named like object members apart from inherited properties', () => {
    const states = apply([started('constructor'), started('__proto__'), started('toString')])
    expect(stateOf(states, 'constructor')?.status).toBe('running')
    expect(stateOf(states, '__proto__')?.status).toBe('running')
    expect(stateOf(states, 'toString')?.status).toBe('running')
    expect(stateOf(states, 'valueOf')).toBeUndefined()
    expect(Object.getPrototypeOf(states)).toBeNull()
  })
})

describe('reduceEvent edges', () => {
  it('hands back the very object it got when a run starts and no state was there', () => {
    const empty: RunStates = Object.freeze(Object.create(null) as Record<string, NodeRunState>)
    expect(reduceEvent(empty, { type: 'run.started', at, runId: RUN, workflowId: 'w', dryRun: false }, RUN)).toBe(empty)
  })

  it('shows a retry that starts without its first attempt known with no error text', () => {
    expect(stateOf(apply([started('a', 2)]), 'a')).toEqual({ status: 'running', attempt: 2, retrying: true, error: null })
  })

  it('ignores a succeeded or continued event of an older attempt', () => {
    const states = apply([started('a'), failed('a', 1, true), started('a', 2)])
    expect(reduceEvent(states, succeeded('a', 1), RUN)).toBe(states)
    expect(reduceEvent(states, { type: 'step.continued', at, runId: RUN, nodeId: 'a', attempt: 1, error: 'x' }, RUN)).toBe(states)
  })

  it('applies an ending event for a node whose start it never saw', () => {
    expect(stateOf(apply([succeeded('a')]), 'a')).toEqual({ status: 'succeeded', attempt: 1, retrying: false, error: null })
    expect(stateOf(apply([failed('b', 2, false, 'x')]), 'b')).toEqual({ status: 'failed', attempt: 2, retrying: false, error: 'x' })
    expect(stateOf(apply([{ type: 'step.continued', at, runId: RUN, nodeId: 'c', attempt: 1, error: 'y' }]), 'c')).toEqual({ status: 'continued', attempt: 1, retrying: false, error: 'y' })
  })
})

describe('reduceRunSummary', () => {
  const run: RunSummary = { id: RUN, workflowId: 'w', status: 'queued', dryRun: false, error: null, createdAt: 1, startedAt: null, finishedAt: null }

  it('shows the run as running when it starts', () => {
    expect(reduceRunSummary(run, { type: 'run.started', at: 10, runId: RUN, workflowId: 'w', dryRun: true })).toEqual({ ...run, status: 'running', dryRun: true, startedAt: 10 })
  })

  it('shows the final status, error and time when it finishes', () => {
    const running = { ...run, status: 'running' as const, startedAt: 10 }
    expect(reduceRunSummary(running, { type: 'run.finished', at: 20, runId: RUN, status: 'failed', error: 'node a failed' })).toEqual({
      ...running,
      status: 'failed',
      error: 'node a failed',
      finishedAt: 20,
    })
  })

  it('returns the same summary for the run.started of another run', () => {
    expect(reduceRunSummary(run, { type: 'run.started', at: 20, runId: 'run-2', workflowId: 'w', dryRun: true })).toBe(run)
  })

  it('clears the finish time and the error when a finished run starts again', () => {
    const finished = { ...run, status: 'failed' as const, error: 'x', startedAt: 5, finishedAt: 9 }
    expect(reduceRunSummary(finished, { type: 'run.started', at: 30, runId: RUN, workflowId: 'w', dryRun: false })).toEqual({
      ...finished,
      status: 'running',
      dryRun: false,
      startedAt: 30,
      finishedAt: null,
      error: null,
    })
  })

  it('returns the same object for other runs and other events', () => {
    expect(reduceRunSummary(run, { type: 'run.finished', at: 20, runId: 'run-2', status: 'failed', error: 'x' })).toBe(run)
    expect(reduceRunSummary(run, { type: 'step.started', at: 20, runId: RUN, nodeId: 'a', attempt: 1 })).toBe(run)
    expect(reduceRunSummary(run, { type: 'trigger.fired', at: 20, workflowId: 'w', runId: RUN })).toBe(run)
  })
})
