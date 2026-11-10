import { describe, expect, it } from 'vitest'
import { transform } from '../src/nodes/transform'
import { makeCtx } from './helpers'

describe('transform@1', () => {
  it('is a pure action', () => {
    expect(transform.type).toBe('transform@1')
    expect(transform.sideEffect).toBe('none')
  })

  it('returns its values unchanged (templates are resolved by the engine)', async () => {
    const output = await transform.execute({ values: { total: 5, label: 'x' } }, makeCtx())
    expect(output).toEqual({ total: 5, label: 'x' })
  })
})
