import { describe, expect, it } from 'vitest'
import { parseWorkflowShape } from '../src/schema'

const valid = {
  schemaVersion: 1,
  name: 'receipts',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    {
      id: 'n1',
      type: 'transform@1',
      config: { values: { a: 1 } },
      retry: { maxAttempts: 3 },
      onError: 'continue',
    },
  ],
  edges: [{ from: 't1', to: 'n1' }],
}

describe('parseWorkflowShape', () => {
  it('accepts a well-formed workflow', () => {
    const result = parseWorkflowShape(valid)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.workflow.nodes).toHaveLength(2)
  })

  it('rejects an unsupported schemaVersion', () => {
    const result = parseWorkflowShape({ ...valid, schemaVersion: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain('schemaVersion')
  })

  it('rejects malformed node ids and types', () => {
    const bad = { ...valid, nodes: [{ id: 'N1', type: 'nope', config: {} }] }
    const result = parseWorkflowShape(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const text = result.errors.join('\n')
      expect(text).toContain('nodes/0/id')
      expect(text).toContain('nodes/0/type')
    }
  })

  it('rejects unknown properties so invented fields are caught', () => {
    expect(parseWorkflowShape({ ...valid, extra: true }).ok).toBe(false)
  })

  it('rejects a workflow without nodes', () => {
    expect(parseWorkflowShape({ ...valid, nodes: [] }).ok).toBe(false)
  })

  it('rejects retry.maxAttempts out of range', () => {
    const bad = { ...valid, nodes: [{ ...valid.nodes[0], retry: { maxAttempts: 99 } }] }
    expect(parseWorkflowShape(bad).ok).toBe(false)
  })

  it('reports every problem instead of stopping at the first', () => {
    const result = parseWorkflowShape({ ...valid, schemaVersion: 2, name: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects non-object input', () => {
    expect(parseWorkflowShape('nope').ok).toBe(false)
    expect(parseWorkflowShape(null).ok).toBe(false)
  })
})
