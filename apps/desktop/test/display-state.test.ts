// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { displayState, NO_STATES, visualStatusOfRun, withState, type NodeRunState } from '../src/model/status'

const done: NodeRunState = { status: 'succeeded', attempt: 1, retrying: false, error: null }

describe('displayState', () => {
  it('returns the state the node has', () => {
    const states = withState(NO_STATES, 'a', done)
    expect(displayState({ id: 'a', type: 'transform@1' }, states)).toBe(done)
  })

  it('shows nothing for a node without state when no run is open', () => {
    expect(displayState({ id: 'a', type: 'transform@1' }, NO_STATES)).toBeUndefined()
    expect(displayState({ id: 't', type: 'trigger.cron@1' }, NO_STATES)).toBeUndefined()
  })

  it('shows a trigger as succeeded once any node of the run has a state, because the run exists', () => {
    const states = withState(NO_STATES, 'a', { status: 'running', attempt: 1, retrying: false, error: null })
    expect(displayState({ id: 't', type: 'trigger.cron@1' }, states)).toMatchObject({ status: 'succeeded', error: null })
    expect(displayState({ id: 'b', type: 'transform@1' }, states)).toBeUndefined()
  })

  it('does not read an inherited property as a state', () => {
    const states = withState(NO_STATES, 'a', done)
    expect(displayState({ id: 'constructor', type: 'transform@1' }, states)).toBeUndefined()
    expect(displayState({ id: 'toString', type: 'trigger.manual@1' }, states)).toMatchObject({ status: 'succeeded' })
  })
})

describe('visualStatusOfRun', () => {
  it('draws each run status as the node status that looks like it', () => {
    expect(visualStatusOfRun('queued')).toBe('idle')
    expect(visualStatusOfRun('running')).toBe('running')
    expect(visualStatusOfRun('succeeded')).toBe('succeeded')
    expect(visualStatusOfRun('failed')).toBe('failed')
    expect(visualStatusOfRun('cancelled')).toBe('abandoned')
  })
})

describe('the state of a fired trigger', () => {
  it('is one frozen object that nobody can change for every card', () => {
    const states = withState(NO_STATES, 'a', done)
    const first = displayState({ id: 't1', type: 'trigger.cron@1' }, states)
    const second = displayState({ id: 't2', type: 'trigger.manual@1' }, states)
    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
  })
})
