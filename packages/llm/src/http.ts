import { classifyHttp } from './classify'
import { MAX_TIMER_MS, startDeadline } from './deadline'
import { readSse, type SseEvent } from './sse'
import { LlmError } from './types'

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface LlmCall {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  expired(): boolean
  remainingMs(): number
  abortError(): LlmError
  dispose(): void
}

export type HttpClassifier = (status: number, bodyText: string, headers: Headers) => LlmError

export interface PostRequest {
  url: string
  headers: Readonly<Record<string, string>>
  body: unknown
  fetch: FetchFn
  call: LlmCall
  secrets?: readonly string[]
  classify?: HttpClassifier
}

export interface JsonReply {
  status: number
  headers: Headers
  body: unknown
}

export interface StreamReply {
  status: number
  headers: Headers
  events: AsyncGenerator<SseEvent>
  close(): Promise<void>
}

export interface StreamHooks {
  onFirstEvent?: () => void
}

export function startCall(timeoutMs: number, caller?: AbortSignal): LlmCall {
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    throw new LlmError('invalid_request', `timeoutMs must be a positive number of milliseconds up to ${MAX_TIMER_MS}, got ${timeoutMs}`)
  }
  const deadline = startDeadline(timeoutMs, caller)
  return {
    signal: deadline.signal,
    timeoutMs,
    expired: deadline.expired,
    remainingMs: deadline.remainingMs,
    abortError: () =>
      deadline.expired()
        ? new LlmError('timeout', `the model reply did not finish within ${timeoutMs} ms`)
        : new LlmError('aborted', 'the request was cancelled'),
    dispose: deadline.dispose,
  }
}

function failure(error: unknown, call: LlmCall): LlmError {
  if (error instanceof LlmError) return error
  if (call.signal.aborted) return call.abortError()
  return new LlmError('connection', 'could not reach the model provider', { cause: error })
}

async function send(request: PostRequest, accept: string): Promise<Response> {
  const { call } = request
  if (call.signal.aborted) throw call.abortError()
  let response: Response
  try {
    response = await request.fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept, ...request.headers },
      body: JSON.stringify(request.body),
      signal: call.signal,
    })
  } catch (error) {
    throw failure(error, call)
  }
  if (response.ok) return response
  let text = ''
  try {
    text = await response.text()
  } catch {
    if (call.signal.aborted) throw call.abortError()
  }
  const classify = request.classify ?? ((status, body, headers) => classifyHttp(status, body, headers, { secrets: request.secrets }))
  throw classify(response.status, text, response.headers)
}

export async function postJson(request: PostRequest): Promise<JsonReply> {
  const response = await send(request, 'application/json')
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw failure(error, request.call)
  }
  try {
    return { status: response.status, headers: response.headers, body: JSON.parse(text) }
  } catch {
    throw new LlmError('invalid_output', 'the model provider returned a body that is not JSON', { status: response.status })
  }
}

export async function postStream(request: PostRequest, hooks: StreamHooks = {}): Promise<StreamReply> {
  const response = await send(request, 'text/event-stream')
  const body = response.body
  if (body === null || /\bjson\b/i.test(response.headers.get('content-type') ?? '')) {
    await body?.cancel().catch(() => undefined)
    throw new LlmError('invalid_output', 'the model provider answered a streaming request with a body that is not a stream', { status: response.status })
  }
  async function* events(): AsyncGenerator<SseEvent> {
    let first = true
    try {
      for await (const event of readSse(body as ReadableStream<Uint8Array>, request.call.signal)) {
        if (first) {
          first = false
          hooks.onFirstEvent?.()
        }
        yield event
      }
    } catch (error) {
      throw failure(error, request.call)
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    events: events(),
    close: async () => {
      if (!body.locked) await body.cancel().catch(() => undefined)
    },
  }
}
