import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createCoreRegistry } from '../src/index'
import { condition } from '../src/nodes/condition'
import { makeCtx } from './helpers'

const run = (config: unknown) => condition.execute(config, makeCtx())

describe('condition@1', () => {
  it('is a registered pure node', () => {
    expect(condition.sideEffect).toBe('none')
    expect(createCoreRegistry().has('condition@1')).toBe(true)
  })

  it.each<[string, unknown, unknown, boolean]>([
    ['eq', 5, 5, true],
    ['eq', 5, 6, false],
    ['eq', { a: [1] }, { a: [1] }, true],
    ['eq', 5, '5', false],
    ['neq', 'a', 'b', true],
    ['gt', 5, 3, true],
    ['gt', 3, 5, false],
    ['gt', 5, 5, false],
    ['gte', 5, 5, true],
    ['gte', 4, 5, false],
    ['lt', 'a', 'b', true],
    ['lt', 'b', 'a', false],
    ['lt', 5, 5, false],
    ['lte', 5, 5, true],
    ['lte', 6, 5, false],
    ['contains', 'hello world', 'world', true],
    ['contains', ['a', 'b'], 'b', true],
    ['contains', ['a'], 'z', false],
    ['exists', 'x', undefined, true],
    ['exists', '', undefined, false],
    ['exists', null, undefined, false],
    ['exists', 0, undefined, true],
  ])('%s %j %j -> %s', async (operator, left, right, expected) => {
    const config = right === undefined ? { left, operator } : { left, operator, right }
    expect(await run(config)).toEqual({ result: expected, branch: String(expected) })
  })

  it('refuses to order mixed or non-comparable values', async () => {
    await expect(run({ left: 5, operator: 'gt', right: '3' })).rejects.toThrow('two numbers or two strings')
    await expect(run({ left: { a: 1 }, operator: 'lt', right: { a: 2 } })).rejects.toThrow('two numbers or two strings')
  })

  it('refuses contains on values that cannot contain', async () => {
    await expect(run({ left: 5, operator: 'contains', right: 5 })).rejects.toThrow('string or an array')
  })

  it('treats a missing left value as not existing and not equal', async () => {
    expect(await run({ operator: 'exists' })).toEqual({ result: false, branch: 'false' })
    expect(await run({ operator: 'eq', right: 5 })).toEqual({ result: false, branch: 'false' })
  })

  it('asks for lenient reference resolution', () => {
    expect(condition.lenientRefs).toBe(true)
  })

  it('requires right for every operator except exists', async () => {
    await expect(run({ left: 1, operator: 'eq' })).rejects.toThrow('operator eq needs a right value')
  })

  it('rejects unknown operators and extra properties in its config schema', () => {
    expect(Value.Check(condition.configSchema, { left: 1, operator: 'eq', right: 1 })).toBe(true)
    expect(Value.Check(condition.configSchema, { left: 1, operator: 'matches', right: 1 })).toBe(false)
    expect(Value.Check(condition.configSchema, { left: 1, operator: 'eq', right: 1, extra: true })).toBe(false)
  })
})
