import { createCoreRegistry, encodeSlackBotSecret } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionSecrets } from '../src/explain'
import { GOOD, allTables, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { isolateKeyEnvironment } from './llm-env'

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const dirOf = useTempDir()
useCleanups()
isolateKeyEnvironment()

const realFetch = globalThis.fetch

function stubSlack(respond: () => Response): void {
  vi.stubGlobal('fetch', (input: URL | string, init?: RequestInit) => (String(input).startsWith('https://slack.com/') ? Promise.resolve(respond()) : realFetch(input, init)))
}

const node = (config: Record<string, unknown> = {}) => ({ id: 'n1', type: 'notify.slack@1', config: { connection: 'bot', text: 'hi', channel: '#alerts', ...config } })

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connectionSecrets with a Slack bot secret', () => {
  const workflow = { schemaVersion: 1 as const, name: 'w', nodes: [node()], edges: [] }

  it('adds the token next to the whole value', () => {
    const secret = encodeSlackBotSecret({ token: TOKEN, channel: '#alerts' })
    expect(connectionSecrets(workflow, [], createCoreRegistry(), { get: () => secret })).toEqual([secret, TOKEN])
  })

  it('adds the token of a plain token secret once more without breaking', () => {
    expect(connectionSecrets(workflow, [], createCoreRegistry(), { get: () => TOKEN })).toEqual([TOKEN, TOKEN])
  })

  it('adds nothing but the url for a webhook', () => {
    const url = 'https://hooks.slack.com/services/T/B/X'
    expect(connectionSecrets(workflow, [], createCoreRegistry(), { get: () => url })).toEqual([url])
  })
})

describe('a failed run with a Slack bot connection', () => {
  const secret = encodeSlackBotSecret({ token: TOKEN, channel: '#default' })
  const cases: Record<string, () => Response> = {
    'a 400 that echoes the token': () => new Response(`bad request for ${TOKEN} {"token":"${TOKEN}"}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
    'a refusal code': () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found', received: TOKEN }), { status: 200, headers: { 'content-type': 'application/json' } }),
    'an unexpected body that echoes the token': () => new Response(`Bearer ${TOKEN}`, { status: 200, headers: { 'content-type': 'text/plain' } }),
  }
  for (const [label, respond] of Object.entries(cases)) {
    it(`never exposes the token after ${label}`, async () => {
      stubSlack(respond)
      const env = await startEnv(dirOf.get(), [{ data: GOOD }], { connections: { get: (name) => (name === 'bot' ? secret : undefined) } })
      const runId = await env.run([node()])
      const detail = await env.client.request('getRun', { runId })
      expect(detail.run.status).toBe('failed')
      expect(detail.steps[0]!.error).toBeTruthy()
      const mark = env.frames.length
      const result = await env.client.request('explainRun', { runId })
      const everything = [
        JSON.stringify(detail),
        JSON.stringify(allTables(env.db)),
        JSON.stringify(env.provider.requests),
        JSON.stringify(result),
        ...env.frames.slice(0, mark),
        ...env.frames.slice(mark),
        ...env.logs,
      ].join('\n')
      for (const hidden of [TOKEN, secret, JSON.stringify(secret).slice(1, -1)]) expect(everything).not.toContain(hidden)
    })
  }

  it('records the fixed Slack failure text for a refusal', async () => {
    stubSlack(() => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const env = await startEnv(dirOf.get(), [{ data: GOOD }], { connections: { get: (name) => (name === 'bot' ? secret : undefined) } })
    const runId = await env.run([node()])
    const detail = await env.client.request('getRun', { runId })
    expect(detail.steps[0]!.error).toBe('Slack: channel_not_found')
  })

  it('posts with the default channel of the connection and succeeds', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (input: URL | string, init?: RequestInit) => {
      if (!String(input).startsWith('https://slack.com/')) return realFetch(input, init)
      seen.push(String(init?.body))
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const env = await startEnv(dirOf.get(), [], { connections: { get: (name) => (name === 'bot' ? secret : undefined) } })
    const runId = await env.run([{ id: 'n1', type: 'notify.slack@1', config: { connection: 'bot', text: 'hello' } }])
    const detail = await env.client.request('getRun', { runId })
    expect(detail.run.status).toBe('succeeded')
    expect(seen).toEqual(['{"channel":"#default","text":"hello"}'])
    expect(JSON.stringify(detail)).not.toContain(TOKEN)
  })
})
