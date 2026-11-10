import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createCoreRegistry } from '../src/index'
import { delay } from '../src/nodes/delay'
import { makeCtx } from './helpers'

describe('delay@1', () => {
  it('is a registered pure node', () => {
    expect(delay.sideEffect).toBe('none')
    expect(createCoreRegistry().has('delay@1')).toBe(true)
  })

  it('waits through the context sleep function', async () => {
    const waits: number[] = []
    const ctx = makeCtx({
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(await delay.execute({ ms: 1500 }, ctx)).toEqual({ waitedMs: 1500 })
    expect(waits).toEqual([1500])
  })

  it('does not wait in a dry run', async () => {
    const waits: number[] = []
    const ctx = makeCtx({
      dryRun: true,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(await delay.execute({ ms: 1500 }, ctx)).toEqual({ waitedMs: 0 })
    expect(waits).toEqual([])
  })

  it('bounds its config', () => {
    expect(Value.Check(delay.configSchema, { ms: 0 })).toBe(true)
    expect(Value.Check(delay.configSchema, { ms: -1 })).toBe(false)
    expect(Value.Check(delay.configSchema, { ms: 86_400_001 })).toBe(false)
    expect(Value.Check(delay.configSchema, { ms: 1.5 })).toBe(false)
  })
})
