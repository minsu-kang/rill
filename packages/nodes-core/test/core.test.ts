import { describe, expect, it } from 'vitest'
import { createCoreRegistry } from '../src/index'

describe('createCoreRegistry', () => {
  it('contains the built-in nodes for this stage', () => {
    const types = createCoreRegistry()
      .list()
      .map((d) => d.type)
    expect(types).toEqual(['trigger.manual@1', 'transform@1', 'csv.append@1'])
  })

  it('returns an independent registry each call', () => {
    expect(createCoreRegistry()).not.toBe(createCoreRegistry())
  })
})
