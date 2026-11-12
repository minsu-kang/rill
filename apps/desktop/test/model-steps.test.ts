import type { StepDetail } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { NO_STATES, NODE_STATUSES, stateOf } from '../src/model/status'
import { statesFromSteps } from '../src/model/steps'

function step(nodeId: string, attempt: number, status: StepDetail['status'], error: string | null = null): StepDetail {
  return { nodeId, attempt, status, input: null, output: null, error, startedAt: 1000 + attempt, finishedAt: status === 'running' ? null : 2000 + attempt }
}

describe('statesFromSteps', () => {
  it('returns no states for no rows', () => {
    expect(Object.keys(statesFromSteps([]))).toEqual([])
  })

  it('maps each of the six step statuses to the same node status', () => {
    const statuses: StepDetail['status'][] = ['running', 'succeeded', 'failed', 'abandoned', 'skipped', 'continued']
    const states = statesFromSteps(statuses.map((status) => step(`n_${status}`, 1, status)))
    for (const status of statuses) expect(stateOf(states, `n_${status}`)?.status).toBe(status)
    expect(NODE_STATUSES).toEqual(['idle', ...statuses])
  })

  it('lets the last attempt of a node win', () => {
    const states = statesFromSteps([step('a', 1, 'failed', 'HTTP 503'), step('a', 2, 'failed', 'HTTP 502'), step('a', 3, 'succeeded')])
    expect(stateOf(states, 'a')).toEqual({ status: 'succeeded', attempt: 3, retrying: false, error: null })
  })

  it('picks the highest attempt even when the rows arrive out of order', () => {
    const states = statesFromSteps([step('a', 3, 'succeeded'), step('a', 1, 'failed', 'x'), step('a', 2, 'failed', 'y')])
    expect(stateOf(states, 'a')?.attempt).toBe(3)
  })

  it('keeps the error text of a failed or continued last attempt', () => {
    const states = statesFromSteps([step('a', 1, 'failed', 'boom'), step('b', 2, 'continued', 'ignored')])
    expect(stateOf(states, 'a')?.error).toBe('boom')
    expect(stateOf(states, 'b')).toMatchObject({ status: 'continued', attempt: 2, error: 'ignored' })
  })

  it('marks a running attempt after the first as retrying', () => {
    const states = statesFromSteps([step('a', 1, 'failed', 'x'), step('a', 2, 'running'), step('b', 1, 'running')])
    expect(stateOf(states, 'a')).toMatchObject({ status: 'running', attempt: 2, retrying: true })
    expect(stateOf(states, 'b')).toMatchObject({ status: 'running', attempt: 1, retrying: false })
  })

  it('shows a failed last row of a running run as a running retry with its error', () => {
    const states = statesFromSteps([step('a', 1, 'failed', 'x'), step('a', 2, 'failed', 'HTTP 503'), step('b', 1, 'succeeded')], 'running')
    expect(stateOf(states, 'a')).toEqual({ status: 'running', attempt: 2, retrying: true, error: 'HTTP 503' })
    expect(stateOf(states, 'b')).toEqual({ status: 'succeeded', attempt: 1, retrying: false, error: null })
  })

  it('keeps a failed last row failed unless the run is running', () => {
    for (const runStatus of ['queued', 'succeeded', 'failed', 'cancelled', undefined] as const) {
      expect(stateOf(statesFromSteps([step('a', 1, 'failed', 'x')], runStatus), 'a'), String(runStatus)).toEqual({ status: 'failed', attempt: 1, retrying: false, error: 'x' })
    }
  })

  it('does not touch the other statuses of a running run', () => {
    const statuses: StepDetail['status'][] = ['running', 'succeeded', 'abandoned', 'skipped', 'continued']
    const states = statesFromSteps(statuses.map((status) => step(`n_${status}`, 1, status)), 'running')
    for (const status of statuses) expect(stateOf(states, `n_${status}`)).toMatchObject({ status, retrying: false })
  })

  it('lets the later of two rows with the same attempt win', () => {
    const states = statesFromSteps([step('a', 1, 'running'), step('a', 1, 'succeeded')])
    expect(stateOf(states, 'a')?.status).toBe('succeeded')
  })

  it('hands back the shared empty states for no rows and freezes any other result', () => {
    expect(statesFromSteps([])).toBe(NO_STATES)
    expect(Object.isFrozen(statesFromSteps([step('a', 1, 'succeeded')]))).toBe(true)
  })

  it('leaves a node without a row out', () => {
    const states = statesFromSteps([step('a', 1, 'succeeded')])
    expect(stateOf(states, 'b')).toBeUndefined()
  })

  it('keeps nodes named like object members apart from inherited properties', () => {
    const states = statesFromSteps([step('constructor', 1, 'failed', 'x'), step('toString', 1, 'succeeded')])
    expect(stateOf(states, 'constructor')?.status).toBe('failed')
    expect(stateOf(states, 'toString')?.status).toBe('succeeded')
    expect(stateOf(states, 'hasOwnProperty')).toBeUndefined()
    expect(stateOf(states, 'valueOf')).toBeUndefined()
  })

  it('does not read inherited properties from a plain object either', () => {
    expect(stateOf({}, 'constructor')).toBeUndefined()
    expect(stateOf({}, 'toString')).toBeUndefined()
  })

  it('does not change the prototype for a node named __proto__', () => {
    const states = statesFromSteps([step('__proto__', 1, 'failed', 'x')])
    expect(stateOf(states, '__proto__')?.status).toBe('failed')
    expect(Object.getPrototypeOf(states)).toBeNull()
    expect(({} as Record<string, unknown>).status).toBeUndefined()
  })

  it('does not change the rows it was given', () => {
    const rows = [step('a', 1, 'failed', 'x'), step('a', 2, 'succeeded')]
    const copy = structuredClone(rows)
    statesFromSteps(rows)
    expect(rows).toEqual(copy)
  })
})
