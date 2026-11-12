import type { FetchFn } from '../src/index'

export type FakeReply =
  | { kind: 'json'; status?: number; headers?: Record<string, string>; body: unknown }
  | { kind: 'text'; status?: number; headers?: Record<string, string>; body: string; contentType?: string }
  | { kind: 'sse'; status?: number; headers?: Record<string, string>; chunks: readonly string[]; then?: 'end' | 'hold' | 'drop' }
  | { kind: 'hang' }
  | { kind: 'network-error'; error?: Error }

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  json: unknown
}

export interface FakeTransport {
  readonly apiKey: string
  readonly fetch: FetchFn
  readonly requests: RecordedRequest[]
  readonly sleeps: number[]
  sleep(ms: number): Promise<void>
  random(): number
  script(...replies: FakeReply[]): void
  openBodies(): number
}

export const jsonReply = (body: unknown, status = 200, headers: Record<string, string> = {}): FakeReply => ({ kind: 'json', status, headers, body })

export const errorReply = (status: number, body: unknown, headers: Record<string, string> = {}): FakeReply => ({ kind: 'json', status, headers, body })

export const sseChunks = (events: readonly { event?: string; data: unknown }[]): string[] =>
  events.map(({ event, data }) => `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)

export const sseReply = (events: readonly { event?: string; data: unknown }[], then: 'end' | 'hold' | 'drop' = 'end', status = 200): FakeReply => ({
  kind: 'sse',
  status,
  chunks: sseChunks(events),
  then,
})

const abortError = () => new DOMException('This operation was aborted', 'AbortError')

export function createFakeTransport(options: { apiKey?: string; random?: () => number } = {}): FakeTransport {
  const queue: FakeReply[] = []
  let last: FakeReply | undefined
  let open = 0
  const requests: RecordedRequest[] = []
  const sleeps: number[] = []
  const encoder = new TextEncoder()

  const sseResponse = (reply: Extract<FakeReply, { kind: 'sse' }>, signal: AbortSignal | undefined): Response => {
    let index = 0
    let finished = false
    const finish = () => {
      if (!finished) {
        finished = true
        open -= 1
      }
    }
    open += 1
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          'abort',
          () => {
            if (finished) return
            finish()
            controller.error(abortError())
          },
          { once: true },
        )
      },
      pull(controller) {
        if (finished) return
        const chunk = reply.chunks[index]
        if (chunk !== undefined) {
          index += 1
          controller.enqueue(encoder.encode(chunk))
        } else if ((reply.then ?? 'end') === 'end') {
          finish()
          controller.close()
        } else if (reply.then === 'drop') {
          finish()
          controller.error(new TypeError('terminated'))
        } else return new Promise<void>(() => undefined)
      },
      cancel() {
        finish()
      },
    })
    return new Response(stream, { status: reply.status ?? 200, headers: { 'content-type': 'text/event-stream', ...reply.headers } })
  }

  const fetch: FetchFn = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const body = typeof init?.body === 'string' ? init.body : ''
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) throw abortError()
    requests.push({ url: String(input), method: init?.method ?? 'GET', headers, body, json: body === '' ? undefined : JSON.parse(body) })
    const reply = queue.shift() ?? last
    if (reply === undefined) throw new Error('fake transport: no reply scripted')
    if (queue.length === 0) last = reply
    switch (reply.kind) {
      case 'network-error':
        throw reply.error ?? new TypeError('fetch failed')
      case 'hang':
        return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(abortError()), { once: true }))
      case 'json':
        return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } })
      case 'text':
        return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': reply.contentType ?? 'text/html', ...reply.headers } })
      case 'sse':
        return sseResponse(reply, signal)
    }
  }

  return {
    apiKey: options.apiKey ?? 'rill-test-key-4f9c2a7e',
    fetch,
    requests,
    sleeps,
    sleep: async (ms) => void sleeps.push(ms),
    random: options.random ?? (() => 0.5),
    script: (...replies) => {
      queue.splice(0, queue.length, ...replies)
      last = undefined
    },
    openBodies: () => open,
  }
}
