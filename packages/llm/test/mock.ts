import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnthropicProvider, type LlmRequest } from '../src/index'

export interface Seen {
  url: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  closed: boolean
}

export interface SseReply {
  events: string[]
  then?: 'end' | 'hold' | 'drop'
}

export interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  raw?: string
  delayMs?: number
  sse?: SseReply
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
      const entry: Seen = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {}, closed: false }
      seen.push(entry)
      res.on('close', () => {
        entry.closed = true
      })
      const reply = respond(entry, seen.length - 1)
      setTimeout(() => {
        if (reply.sse !== undefined) {
          res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream', ...reply.headers })
          res.write(reply.sse.events.join(''))
          if (reply.sse.then === 'drop') setTimeout(() => res.socket?.destroy(), 30)
          else if (reply.sse.then !== 'hold') res.end()
          return
        }
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


export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

type Json = Record<string, unknown>

function split(text: string): string[] {
  const middle = Math.floor(text.length / 2)
  return middle === 0 ? [text] : [text.slice(0, middle), text.slice(middle)]
}

export function streamEvents(reply: Json): string[] {
  const { content, usage, stop_reason, stop_sequence, stop_details, ...rest } = reply as Json & { content: Json[]; usage: Json }
  const { output_tokens, iterations, ...startUsage } = usage
  const events = [
    sse('message_start', {
      type: 'message_start',
      message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage: { ...startUsage, output_tokens: 0 } },
    }),
  ]
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      for (const text of split(String(block.text))) {
        events.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }))
      }
    } else if (block.type === 'thinking') {
      events.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }))
      events.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(block.thinking ?? '') } }))
      events.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: String(block.signature ?? '') } }))
    } else {
      events.push(sse('content_block_start', { type: 'content_block_start', index, content_block: block }))
    }
    events.push(sse('content_block_stop', { type: 'content_block_stop', index }))
  })
  events.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason, stop_sequence: stop_sequence ?? null, ...(stop_details === undefined ? {} : { stop_details }) },
      usage: { output_tokens, ...(iterations === undefined ? {} : { iterations }) },
    }),
    sse('message_stop', { type: 'message_stop' }),
  )
  return events
}
