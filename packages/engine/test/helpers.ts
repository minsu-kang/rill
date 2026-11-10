import { RetryableError, createCoreRegistry, defineAction, type NodeRegistry } from '@rill/nodes-core'
import Type from 'typebox'
import { Db } from '../src/db'
import { Engine } from '../src/engine'

export function createTestRegistry(calls: string[] = []): NodeRegistry {
  return createCoreRegistry()
    .register(
      defineAction({
        type: 'test.echo@1',
        title: 'Echo',
        description: 'Returns its value.',
        sideEffect: 'none',
        configSchema: Type.Object({ value: Type.Unknown() }, { additionalProperties: false }),
        outputSchema: Type.Object({ value: Type.Unknown() }),
        execute: async (config, ctx) => {
          calls.push(ctx.nodeId)
          return { value: config.value }
        },
      }),
    )
    .register(
      defineAction({
        type: 'test.flaky@1',
        title: 'Flaky',
        description: 'Fails with a retryable error for the first failTimes attempts.',
        sideEffect: 'none',
        configSchema: Type.Object({ failTimes: Type.Integer() }, { additionalProperties: false }),
        outputSchema: Type.Object({ attempt: Type.Integer() }),
        execute: async (config, ctx) => {
          calls.push(ctx.nodeId)
          if (ctx.attempt <= config.failTimes) throw new RetryableError(`transient ${ctx.attempt}`)
          return { attempt: ctx.attempt }
        },
      }),
    )
    .register(
      defineAction({
        type: 'test.fail@1',
        title: 'Fail',
        description: 'Always throws a plain error.',
        sideEffect: 'none',
        configSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({}),
        execute: async (_config, ctx) => {
          calls.push(ctx.nodeId)
          throw new Error('permanent')
        },
      }),
    )
}

export function createTestEngine(options: { calls?: string[] } = {}) {
  const db = Db.open(':memory:')
  const sleeps: number[] = []
  const engine = new Engine({
    db,
    registry: createTestRegistry(options.calls),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 1,
  })
  return { db, engine, sleeps }
}

interface StepSpec {
  id: string
  type: string
  config?: Record<string, unknown>
  retry?: { maxAttempts: number; baseDelayMs?: number }
  onError?: 'fail' | 'continue'
}

export function linearWorkflow(steps: StepSpec[]): unknown {
  return {
    schemaVersion: 1,
    name: 'test',
    nodes: steps.map((s) => ({
      id: s.id,
      type: s.type,
      config: s.config ?? {},
      ...(s.retry ? { retry: s.retry } : {}),
      ...(s.onError ? { onError: s.onError } : {}),
    })),
    edges: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })),
  }
}
