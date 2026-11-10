import { describe, expect, it } from 'vitest'
import { createCoreRegistry } from '../src/index'

describe('createCoreRegistry', () => {
  it('contains the nodes from Plan 1 and has no duplicates', () => {
    const types = createCoreRegistry()
      .list()
      .map((d) => d.type)
    expect(types).toEqual(expect.arrayContaining(['trigger.manual@1', 'transform@1', 'csv.append@1']))
    expect(new Set(types).size).toBe(types.length)
  })

  it('returns an independent registry each call', () => {
    expect(createCoreRegistry()).not.toBe(createCoreRegistry())
  })
})
