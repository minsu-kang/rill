import { describe, expect, it } from 'vitest'
import { incomingEdges, outgoingEdges, validateGraph } from '../src/graph'
import { parseWorkflowShape, type Workflow } from '../src/schema'

const node = (id: string, type = 'transform@1') => ({ id, type, config: {} })

const make = (edges: Workflow['edges']): Workflow => ({
  schemaVersion: 1,
  name: 'wf',
  nodes: [node('t1', 'trigger.manual@1'), node('c1', 'condition@1'), node('a'), node('b')],
  edges,
})

describe('edge when labels', () => {
  it('accepts a when label', () => {
    const result = parseWorkflowShape(make([{ from: 'c1', to: 'a', when: 'true' }]))
    expect(result.ok).toBe(true)
  })

  it('rejects an empty or oversized when label', () => {
    expect(parseWorkflowShape(make([{ from: 'c1', to: 'a', when: '' }])).ok).toBe(false)
    expect(parseWorkflowShape(make([{ from: 'c1', to: 'a', when: 'x'.repeat(65) }])).ok).toBe(false)
  })

  it('rejects a when label on an edge that leaves the trigger', () => {
    const wf = make([
      { from: 't1', to: 'c1', when: 'true' },
      { from: 'c1', to: 'a' },
      { from: 'c1', to: 'b' },
    ])
    expect(validateGraph(wf).join()).toContain('edge from the trigger cannot have a when condition: t1 -> c1')
  })

  it('allows when labels on edges that leave other nodes', () => {
    const wf = make([
      { from: 't1', to: 'c1' },
      { from: 'c1', to: 'a', when: 'true' },
      { from: 'c1', to: 'b', when: 'false' },
    ])
    expect(validateGraph(wf)).toEqual([])
  })
})

describe('incomingEdges and outgoingEdges', () => {
  const wf = make([
    { from: 't1', to: 'c1' },
    { from: 'c1', to: 'a', when: 'true' },
    { from: 'c1', to: 'b', when: 'false' },
  ])

  it('lists edges entering a node', () => {
    expect(incomingEdges(wf, 'a')).toEqual([{ from: 'c1', to: 'a', when: 'true' }])
    expect(incomingEdges(wf, 't1')).toEqual([])
  })

  it('lists edges leaving a node', () => {
    expect(outgoingEdges(wf, 'c1').map((e) => e.to)).toEqual(['a', 'b'])
  })
})
