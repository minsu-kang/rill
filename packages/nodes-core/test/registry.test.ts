import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { NodeRegistry, RetryableError, defineAction, defineTrigger } from '../src/index'
import { makeCtx } from './helpers'

const trigger = defineTrigger({
  type: 'trigger.test@1',
  title: 'Test trigger',
  description: 'For tests.',
  outputSchema: Type.Object({}),
})

const double = defineAction({
  type: 'test.double@1',
  title: 'Double',
  description: 'Doubles n.',
  sideEffect: 'none',
  configSchema: Type.Object({ n: Type.Number() }),
  outputSchema: Type.Object({ doubled: Type.Number() }),
  execute: async (config) => ({ doubled: config.n * 2 }),
})

describe('NodeRegistry', () => {
  it('registers and looks up definitions by type', () => {
    const registry = new NodeRegistry().register(trigger).register(double)
    expect(registry.has('test.double@1')).toBe(true)
    expect(registry.get('trigger.test@1')?.kind).toBe('trigger')
    expect(registry.get('missing@1')).toBeUndefined()
  })

  it('lists definitions in registration order', () => {
    const registry = new NodeRegistry().register(trigger).register(double)
    expect(registry.list().map((d) => d.type)).toEqual(['trigger.test@1', 'test.double@1'])
  })

  it('rejects a duplicate type', () => {
    const registry = new NodeRegistry().register(double)
    expect(() => registry.register(double)).toThrow('already registered: test.double@1')
  })
})

describe('defineAction', () => {
  it('produces an action whose execute can be called with a config', async () => {
    expect(double.kind).toBe('action')
    if (double.kind === 'action') {
      expect(await double.execute({ n: 2 }, makeCtx())).toEqual({ doubled: 4 })
    }
  })
})

describe('RetryableError', () => {
  it('is an Error with its own name', () => {
    const error = new RetryableError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RetryableError')
  })
})
