import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnthropicProvider, type LlmRequest } from '../src/index'

export interface Seen {
  url: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  raw?: string
  delayMs?: number
}

const servers: Server[] = []

export async function closeServers() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export async function mock(respond: (seen: Seen, index: number) => Reply) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const entry: Seen = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} }
      seen.push(entry)
      const reply = respond(entry, seen.length - 1)
      setTimeout(() => {
        const type = reply.raw === undefined ? 'application/json' : 'text/html'
        res.writeHead(reply.status ?? 200, { 'content-type': type, ...reply.headers })
        res.end(reply.raw ?? JSON.stringify(reply.body))
      }, reply.delayMs ?? 0)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { seen, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

export const message = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  ...overrides,
})

export const errorBody = (type: string, text: string) => ({ type: 'error', error: { type, message: text } })

export const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false }
export const request: LlmRequest = { messages: [{ role: 'user', content: 'hello' }], schema }

export function provider(baseURL: string, options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  return new AnthropicProvider({ apiKey: 'test-key', baseURL, maxRetries: 0, ...options })
}

