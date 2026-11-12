import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError, MODEL_TABLE, PROVIDER_IDS, providerDescriptor, type FetchFn, type LlmProvider, type LlmResult, type ProviderId } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { PlanError } from '@rill/planner'
import { RillClient, RillError, type MethodParams } from '@rill/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { configuredProviders } from '../src/llm-models'
import { RillServer } from '../src/server/server'
import { MARKER_KEYS, MARKER_VALUES, isolateKeyEnvironment, mentionsAny } from './llm-env'
import { ScriptedProvider } from './plan-helpers'

isolateKeyEnvironment()

const TOKEN = 'llm-token-0123456789abcdef'
const UPSTREAM_SECRET = 'UPSTREAM-SECRET-TEXT-5521'

let dir: string
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-server-llm-'))
  mkdirSync(join(dir, 'attachments'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function start(engineOptions: Partial<EngineOptions> = {}) {
  const logs: string[] = []
  const engine = new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: [dir], ...engineOptions })
  cleanups.push(() => engine.shutdown())
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const frames: string[] = []
  const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN, {
    socketFactory: (target, protocols) => {
      const socket = new WebSocket(target, protocols)
      socket.addEventListener('message', (event) => frames.push(String(event.data)))
      return socket as never
    },
  })
  cleanups.push(() => client.close())
  return { engine, client, frames, logs, url: `ws://127.0.0.1:${port}/` }
}

async function failure(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

const planParams = (overrides: Partial<MethodParams<'plan'>> = {}): MethodParams<'plan'> => ({
  planId: 'plan-1',
  text: 'Wait a little',
  turns: [],
  attachments: [],
  effort: 'medium',
  ...overrides,
})

describe('llmModels over the websocket', () => {
  it('answers with every model, the per-provider flags and the active model', async () => {
    const configured = configuredProviders({ OPENAI_API_KEY: 'x', XAI_API_KEY: 'y' })
    const { client } = await start({ llmInfo: { configured, active: { provider: 'openai', model: 'gpt-6.1-sol' } } })
    const result = await client.request('llmModels', {})
    expect(result.models).toHaveLength(MODEL_TABLE.length)
    expect(result.models.map((model) => model.id)).toContain('muse-spark-1.3')
    expect(result.providers.map((entry) => [entry.id, entry.configured])).toEqual([
      ['anthropic', false],
      ['openai', true],
      ['gemini', false],
      ['grok', true],
      ['meta', false],
    ])
    expect(result.active).toEqual({ provider: 'openai', model: 'gpt-6.1-sol' })
  })

  it('answers for an engine that has no model information: none configured, none active', async () => {
    const { client } = await start()
    const result = await client.request('llmModels', {})
    expect(result.providers.every((entry) => !entry.configured)).toBe(true)
    expect(result.active).toBeNull()
  })

  it('rejects parameters', async () => {
    const { client } = await start()
    expect((await failure(client.request('llmModels', { provider: 'openai' } as never))).code).toBe('INVALID_PARAMS')
  })

  it('never sends a key, a header or any part of a key, in a result, an event or a log line', async () => {
    const env = { ...MARKER_KEYS, ANTHROPIC_AUTH_TOKEN: 'sk-ant-MARKER-token-77' }
    const { client, frames, logs } = await start({ llmInfo: { configured: configuredProviders(env), active: { provider: 'anthropic', model: 'claude-opus-5-5' } } })
    const result = await client.request('llmModels', {})
    expect(result.providers.every((entry) => entry.configured)).toBe(true)
    const everything = [...frames, ...logs, JSON.stringify(result)].join('\n')
    expect(mentionsAny(everything, [...MARKER_VALUES, 'MARKER', 'sk-ant-'])).toBeUndefined()
  })
})

function authProvider(id: ProviderId): LlmProvider {
  const model = MODEL_TABLE.find((entry) => entry.provider === id)!
  return {
    name: id,
    capabilities: model.capabilities,
    generate: (): Promise<LlmResult> => Promise.reject(new LlmError('auth', `invalid key for ${id}: ${UPSTREAM_SECRET}`, { status: 401 })),
  }
}

const rejecting = (status: number): FetchFn => async () =>
  new Response(JSON.stringify({ error: { type: 'authentication_error', code: status, status: 'UNAUTHENTICATED', message: `Incorrect API key provided: ${UPSTREAM_SECRET}` } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('LLM_UNAVAILABLE for a provider authentication failure', () => {
  it.each(PROVIDER_IDS)('maps an auth error from a %s provider on plan', async (id) => {
    const { client, frames, logs } = await start({ llm: authProvider(id) })
    const error = await failure(client.request('plan', planParams()))
    expect(error).toMatchObject({ code: 'LLM_UNAVAILABLE', message: 'the model provider rejected the credentials' })
    expect(mentionsAny([...frames, ...logs, JSON.stringify(error)].join('\n'), [UPSTREAM_SECRET])).toBeUndefined()
    expect((await client.request('getPlan', { planId: 'plan-1' })).plan.status).toBe('failed')
  })

  it.each(PROVIDER_IDS)('maps the 401 that the real %s adapter classifies as auth', async (id) => {
    const model = MODEL_TABLE.find((entry) => entry.provider === id)!
    const llm = providerDescriptor(id).create({ model: model.id, apiKey: MARKER_VALUES[0]!, fetch: rejecting(401), maxRetries: 0, sleep: async () => undefined, random: () => 0 })
    const { client, frames, logs } = await start({ llm })
    const error = await failure(client.request('plan', planParams()))
    expect(error).toMatchObject({ code: 'LLM_UNAVAILABLE', message: 'the model provider rejected the credentials' })
    expect(mentionsAny([...frames, ...logs, JSON.stringify(error)].join('\n'), [UPSTREAM_SECRET, MARKER_VALUES[0]!])).toBeUndefined()
  })

  it.each(PROVIDER_IDS)('keeps other %s failures as PLAN_PROVIDER', async (id) => {
    const provider = authProvider(id)
    const { client } = await start({ llm: { ...provider, generate: () => Promise.reject(new LlmError('overloaded', 'busy', { status: 529 })) } })
    expect(await failure(client.request('plan', planParams()))).toMatchObject({ code: 'PLAN_PROVIDER', message: 'the model provider failed' })
  })

  it('maps an auth error that reaches the server without a PlanError around it', async () => {
    const thrown = (error: unknown) => {
      const fail = () => {
        throw error
      }
      return { on: () => () => undefined, plan: fail } as unknown as Engine
    }
    const { url } = await startWith(thrown(new LlmError('auth', `rejected ${UPSTREAM_SECRET}`)))
    const client = await RillClient.connect(url, TOKEN)
    cleanups.push(() => client.close())
    const error = await failure(client.request('plan', planParams()))
    expect(error).toMatchObject({ code: 'LLM_UNAVAILABLE', message: 'the model provider rejected the credentials' })
    expect(JSON.stringify(error)).not.toContain(UPSTREAM_SECRET)
  })

  it('maps a PlanError whose cause is an auth error, and not one whose cause is another kind', async () => {
    const scripted = new ScriptedProvider([{ error: new LlmError('auth', 'bad key') }, { error: new LlmError('rate_limit', 'slow down') }, { error: new Error('plain') }])
    const { client } = await start({ llm: scripted })
    expect((await failure(client.request('plan', planParams({ planId: 'a' })))).code).toBe('LLM_UNAVAILABLE')
    expect((await failure(client.request('plan', planParams({ planId: 'b' })))).code).toBe('PLAN_PROVIDER')
    expect((await failure(client.request('plan', planParams({ planId: 'c' })))).code).toBe('INTERNAL')
    expect(new PlanError('provider', 'x', [], [], { cause: new LlmError('auth', 'k') }).cause).toBeInstanceOf(LlmError)
  })
})

async function startWith(engine: Engine) {
  const server = new RillServer({ engine, token: TOKEN, log: () => undefined })
  const port = await server.listen()
  cleanups.push(() => server.close())
  return { url: `ws://127.0.0.1:${port}/` }
}
