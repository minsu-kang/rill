import { describe, expect, it } from 'vitest'
import { isTrigger, topologicalOrder, validateGraph } from '../src/graph'
import type { Workflow } from '../src/schema'

const node = (id: string, type = 'transform@1') => ({ id, type, config: {} })
const trigger = node('t1', 'trigger.manual@1')

const make = (nodes: Workflow['nodes'], edges: Workflow['edges']): Workflow => ({
  schemaVersion: 1,
  name: 'wf',
  nodes,
  edges,
})

describe('isTrigger', () => {
  it('detects trigger types by prefix', () => {
    expect(isTrigger('trigger.manual@1')).toBe(true)
    expect(isTrigger('transform@1')).toBe(false)
  })
})

describe('validateGraph', () => {
  it('accepts a linear workflow', () => {
    const wf = make([trigger, node('a'), node('b')], [
      { from: 't1', to: 'a' },
      { from: 'a', to: 'b' },
    ])
    expect(validateGraph(wf)).toEqual([])
  })

  it('requires exactly one trigger', () => {
    expect(validateGraph(make([node('a')], [])).join()).toContain('exactly 1 trigger')
    const two = make([trigger, node('t2', 'trigger.manual@1')], [])
    expect(validateGraph(two).join()).toContain('exactly 1 trigger')
  })

  it('rejects duplicate node ids', () => {
    const wf = make([trigger, node('a'), node('a')], [{ from: 't1', to: 'a' }])
    expect(validateGraph(wf).join()).toContain('duplicate node id: a')
  })

  it('rejects edges to unknown nodes', () => {
    const wf = make([trigger], [{ from: 't1', to: 'ghost' }])
    expect(validateGraph(wf).join()).toContain('unknown node: ghost')
  })

  it('rejects incoming edges on the trigger', () => {
    const wf = make([trigger, node('a')], [
      { from: 't1', to: 'a' },
      { from: 'a', to: 't1' },
    ])
    expect(validateGraph(wf).join()).toContain('trigger must not have incoming edges')
  })

  it('rejects cycles', () => {
    const wf = make([trigger, node('a'), node('b')], [
      { from: 't1', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
    expect(validateGraph(wf).join()).toContain('cycle')
  })

  it('rejects nodes the trigger cannot reach', () => {
    const wf = make([trigger, node('a'), node('island')], [{ from: 't1', to: 'a' }])
    expect(validateGraph(wf).join()).toContain('not reachable from trigger: island')
  })
})

describe('topologicalOrder', () => {
  it('orders nodes so every edge points forward', () => {
    const wf = make([trigger, node('a'), node('b'), node('c')], [
      { from: 't1', to: 'a' },
      { from: 't1', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ])
    expect(topologicalOrder(wf)).toEqual(['t1', 'a', 'b', 'c'])
  })

  it('returns null for a cycle', () => {
    const wf = make([node('a'), node('b')], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
    expect(topologicalOrder(wf)).toBeNull()
  })
})
