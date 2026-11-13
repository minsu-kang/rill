import { encodeSlackBotSecret } from '@rill/nodes-core'
import { vi } from 'vitest'
import type { HookActionInput, HookInput } from '@rill/protocol'
import { ConnectionTable } from '../src/connection-channel'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { createTestRegistry } from './helpers'

export const BOT_TOKEN = 'xoxb-HOOKTOKENMARKER0123'
export const WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/HOOKWEBHOOKMARKER'

export function connectionTable(): ConnectionTable {
  const table = new ConnectionTable()
  table.setTyped('team-slack', encodeSlackBotSecret({ token: BOT_TOKEN, channel: '#default' }), 'slack', { slack: 'bot' })
  table.setTyped('bare-bot', encodeSlackBotSecret({ token: BOT_TOKEN }), 'slack', { slack: 'bot' })
  table.setTyped('hook-slack', WEBHOOK_URL, 'slack', { slack: 'webhook' })
  table.setTyped('api', 'plain-http-secret', 'http')
  table.setPlain('legacy', WEBHOOK_URL)
  return table
}

export function notify(connection = 'team-slack', channel?: string): HookActionInput {
  return { type: 'notify', connection, ...(channel === undefined ? {} : { channel }) }
}

export function hookInput(overrides: Partial<HookInput> = {}): HookInput {
  return { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true, ...overrides }
}

export function echoWorkflow(name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    name,
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'n1', type: 'test.echo@1', config: { value: '{{t1.output}}', ...extra } },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  }
}

export function failingWorkflow(name: string): unknown {
  return {
    schemaVersion: 1,
    name,
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'n1', type: 'test.fail@1', config: {} },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  }
}

export function openEngine(options: Partial<EngineOptions> & { table?: ConnectionTable } = {}) {
  const { table = connectionTable(), ...rest } = options
  const db = rest.db ?? Db.open(':memory:')
  const engine = new Engine({ registry: createTestRegistry(), connections: table.resolver, sleep: async () => {}, ...rest, db })
  return { engine, db, table }
}

export interface SlackCall {
  url: string
  method: string
  headers: Headers
  body: string
  redirect: string | undefined
  signal: AbortSignal | undefined
}

export const slackJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

export function stubSlack(respond?: (call: SlackCall) => Response | Promise<Response>): SlackCall[] {
  const calls: SlackCall[] = []
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const call: SlackCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    if (respond !== undefined) return respond(call)
    return call.url.includes('slack.com/api/') ? slackJson({ ok: true }) : new Response('ok', { status: 200 })
  })
  return calls
}

export const textOf = (call: SlackCall): string => (JSON.parse(call.body) as { text: string }).text
