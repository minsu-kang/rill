import { isDeepStrictEqual } from 'node:util'
import Type from 'typebox'
import { defineAction } from '../types'

type Operator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists'

function order(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0
  throw new Error('comparison needs two numbers or two strings')
}

function evaluate(operator: Operator, left: unknown, right: unknown): boolean {
  switch (operator) {
    case 'eq':
      return isDeepStrictEqual(left, right)
    case 'neq':
      return !isDeepStrictEqual(left, right)
    case 'gt':
      return order(left, right) > 0
    case 'gte':
      return order(left, right) >= 0
    case 'lt':
      return order(left, right) < 0
    case 'lte':
      return order(left, right) <= 0
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right)
      if (Array.isArray(left)) return left.some((item) => isDeepStrictEqual(item, right))
      throw new Error('contains needs a string or an array on the left')
    case 'exists':
      return left !== null && left !== undefined && left !== ''
  }
}

export const condition = defineAction({
  type: 'condition@1',
  title: 'Condition',
  description: 'Compares two values and selects the true or false branch for edges labelled with when.',
  sideEffect: 'none',
  lenientRefs: true,
  configSchema: Type.Object(
    {
      left: Type.Optional(Type.Unknown()),
      operator: Type.Union([
        Type.Literal('eq'),
        Type.Literal('neq'),
        Type.Literal('gt'),
        Type.Literal('gte'),
        Type.Literal('lt'),
        Type.Literal('lte'),
        Type.Literal('contains'),
        Type.Literal('exists'),
      ]),
      right: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object({
    result: Type.Boolean(),
    branch: Type.Union([Type.Literal('true'), Type.Literal('false')]),
  }),
  execute: async (config) => {
    if (config.operator !== 'exists' && config.right === undefined) {
      throw new Error(`operator ${config.operator} needs a right value`)
    }
    const result = evaluate(config.operator, config.left, config.right)
    const branch: 'true' | 'false' = result ? 'true' : 'false'
    return { result, branch }
  },
})
