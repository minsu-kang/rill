import { describe, expect, it } from 'vitest'
import { validateReferences } from '../src/references'
import type { Workflow } from '../src/schema'

const node = (id: string, config: Record<string, unknown> = {}, type = 'transform@1') => ({ id, type, config })

const make = (nodes: Workflow['nodes'], edges: Workflow['edges']): Workflow => ({
  schemaVersion: 1,
  name: 'wf',
  nodes,
  edges,
})

const t1 = node('t1', {}, 'trigger.manual@1')

describe('validateReferences', () => {
  it('accepts references to upstream nodes, including indirect ones', () => {
    const wf = make(
      [t1, node('a', { x: '{{t1.output.file}}' }), node('b', { y: 'v={{a.output.x}} {{t1.output.file}}' })],
      [
        { from: 't1', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    )
    expect(validateReferences(wf)).toEqual([])
  })

  it('accepts a workflow without references', () => {
    expect(validateReferences(make([t1, node('a', { x: 1 })], [{ from: 't1', to: 'a' }]))).toEqual([])
  })

  it('rejects references to unknown nodes', () => {
    const wf = make([t1, node('a', { x: '{{ghost.output.v}}' })], [{ from: 't1', to: 'a' }])
    expect(validateReferences(wf)).toEqual(['a: reference to unknown node ghost'])
  })

  it('rejects references to downstream nodes and to itself', () => {
    const wf = make(
      [t1, node('a', { x: '{{b.output.v}}', y: '{{a.output.v}}' }), node('b')],
      [
        { from: 't1', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    )
    expect(validateReferences(wf)).toEqual([
      'a: reference to b which does not run before it',
      'a: reference to a which does not run before it',
    ])
  })

  it('rejects references to a node on a sibling branch', () => {
    const wf = make(
      [t1, node('c1', {}, 'condition@1'), node('yes'), node('no', { v: '{{yes.output.v}}' })],
      [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'yes', when: 'true' },
        { from: 'c1', to: 'no', when: 'false' },
      ],
    )
    expect(validateReferences(wf)).toEqual(['no: reference to yes which does not run before it'])
  })

  it('rejects malformed template spans so typos do not slip through as literal text', () => {
    const wf = make(
      [
        t1,
        node('a', {
          x: '{{t1.outputs.file}}',
          y: ['{{T1.output.file}}', '{{ t1.output.items[0] }}'],
          z: '{{t1.output.file}}',
        }),
      ],
      [{ from: 't1', to: 'a' }],
    )
    expect(validateReferences(wf)).toEqual([
      'a: malformed template {{t1.outputs.file}}',
      'a: malformed template {{T1.output.file}}',
      'a: malformed template {{ t1.output.items[0] }}',
    ])
  })

  it('accepts hyphenated path segments such as response header names', () => {
    const wf = make([t1, node('a', { ct: '{{t1.output.headers.content-type}}' })], [{ from: 't1', to: 'a' }])
    expect(validateReferences(wf)).toEqual([])
  })

  it('terminates on cyclic graphs', () => {
    const wf = make(
      [t1, node('a', { x: '{{b.output.v}}' }), node('b')],
      [
        { from: 't1', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    )
    expect(validateReferences(wf)).toEqual([])
  })
})
