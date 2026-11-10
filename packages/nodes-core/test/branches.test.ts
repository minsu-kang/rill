import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { declaredBranches, defineAction } from '../src/index'
import { condition } from '../src/nodes/condition'
import { transform } from '../src/nodes/transform'
import { triggerManual } from '../src/nodes/trigger-manual'

function nodeWith<O extends Type.TSchema>(outputSchema: O) {
  return defineAction({
    type: 'test.node@1',
    title: 'Test',
    description: 'Test node.',
    sideEffect: 'none',
    configSchema: Type.Object({}),
    outputSchema,
    execute: async () => ({}) as Type.Static<O>,
  })
}

describe('declaredBranches', () => {
  it('lists the literal values of a condition', () => {
    expect(declaredBranches(condition)).toEqual(['true', 'false'])
  })

  it('returns null for nodes without a branch output and for triggers', () => {
    expect(declaredBranches(transform)).toBeNull()
    expect(declaredBranches(triggerManual)).toBeNull()
  })

  it('reads a single literal and a union of literals', () => {
    expect(declaredBranches(nodeWith(Type.Object({ branch: Type.Literal('only') })))).toEqual(['only'])
    expect(
      declaredBranches(nodeWith(Type.Object({ branch: Type.Union([Type.Literal('a'), Type.Literal('b')]) }))),
    ).toEqual(['a', 'b'])
  })

  it('accepts any label when branch is declared without fixed values', () => {
    expect(declaredBranches(nodeWith(Type.Object({ branch: Type.String() })))).toBe('any')
    expect(declaredBranches(nodeWith(Type.Object({ branch: Type.Number() })))).toBe('any')
  })
})
