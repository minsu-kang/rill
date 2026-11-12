import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PNG_BASE64, RETRY_AFTER_MS, type ConformanceGoldens, type ConformanceWire } from '../conformance'
import { errorReply, sseReply, type FakeReply } from '../fake-transport'

export const GROK_MODEL = 'grok-4.7'
export const GROK_ENDPOINT = 'https://api.x.ai/v1/responses'
export const SYSTEM_KEY = 'rill-d60713d238725fdc8676819d8ee8e0ff'
export const CACHE_SYSTEM_KEY = 'rill-0e2767fb2d17e03321324827d5962241'
export const OUTPUT_NAME = 'rill_output'

export const RAW_USAGE = {
  input_tokens: 6200,
  input_tokens_details: { cached_tokens: 5000 },
  output_tokens: 900,
  output_tokens_details: { reasoning_tokens: 2400 },
  total_tokens: 9500,
  cost_in_usd_ticks: 38_000_000,
}
export const USAGE = { inputTokens: 1200, outputTokens: 3300, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0 }

type Status = 'completed' | 'incomplete'

export interface ResponseOptions {
  status?: Status
  reason?: string | null
  text?: string
  content?: unknown[]
  output?: unknown[]
  usage?: unknown
  model?: string
  extra?: Record<string, unknown>
}

export function responseObject(options: ResponseOptions = {}): Record<string, unknown> {
  const status = options.status ?? 'completed'
  const content = options.content ?? [{ type: 'output_text', text: options.text ?? JSON.stringify(CONFORMANCE_DATA) }]
  return {
    id: 'resp_fixture',
    object: 'response',
    model: options.model ?? GROK_MODEL,
    status,
    incomplete_details: options.reason === undefined || options.reason === null ? null : { reason: options.reason },
    output: options.output ?? [
      { type: 'reasoning', summary: [], encrypted_content: 'ZW5jcnlwdGVk' },
      { type: 'message', role: 'assistant', status: 'completed', content },
    ],
    usage: options.usage === undefined ? RAW_USAGE : options.usage,
    service_tier: 'default',
    store: false,
    ...options.extra,
  }
}

type Ev = { event?: string; data: unknown }

export const created = (): Ev => ({ event: 'response.created', data: { type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } } })
export const delta = (text: string): Ev => ({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: text } })
export const completed = (options: ResponseOptions = {}): Ev => ({ event: 'response.completed', data: { type: 'response.completed', response: responseObject(options) } })
export const incomplete = (options: ResponseOptions = {}): Ev => ({
  event: 'response.incomplete',
  data: { type: 'response.incomplete', response: responseObject({ status: 'incomplete', ...options }) },
})

export function streamOf(options: ResponseOptions = {}, terminal: 'completed' | 'incomplete' = 'completed'): Ev[] {
  const text = options.text ?? JSON.stringify(CONFORMANCE_DATA)
  const half = Math.floor(text.length / 2)
  return [created(), delta(text.slice(0, half)), delta(text.slice(half)), terminal === 'completed' ? completed(options) : incomplete(options)]
}

export const okReply = (options: ResponseOptions = {}): FakeReply => sseReply(streamOf(options))

export const grokWire = (model = GROK_MODEL): ConformanceWire => ({
  mode: 'sse',
  maxTokens: 4000,
  endpoint: GROK_ENDPOINT,
  ok: { reply: okReply({ model }), data: CONFORMANCE_DATA, usage: USAGE, model, stopReason: 'end_turn' },
  truncated: { reply: sseReply(streamOf({ model, text: '{"a":', reason: 'max_output_tokens' }, 'incomplete')), usage: USAGE },
  refusal: { reply: okReply({ model, content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }), usage: USAGE },
  notJson: okReply({ model, text: 'not json' }),
  auth: errorReply(401, { error: { message: `Incorrect API key provided: ${CONFORMANCE_API_KEY}`, code: 'invalid_api_key', param: null, type: 'authentication_error' } }, { 'x-request-id': 'req-auth' }),
  rateLimit: errorReply(429, { code: 'rate-limit', error: 'Too many requests for this team' }, { 'retry-after': String(RETRY_AFTER_MS / 1000) }),
  overloaded: errorReply(503, { code: 'unavailable', error: 'Service temporarily unavailable' }),
  invalidRequest: errorReply(400, { code: 'invalid-argument', error: 'The schema is not accepted' }),
  contextTooLong: errorReply(400, { code: 'invalid-argument', error: 'This model has a maximum context length of 500000 tokens, but the prompt was longer' }),
  goldens: grokGoldens(4000, model),
})

const user = (content: unknown) => ({ role: 'user', content })

export function grokGoldens(maxTokens: number, model = GROK_MODEL): ConformanceGoldens {
  const common = { model, stream: true, store: false, max_output_tokens: maxTokens, reasoning: { effort: 'medium' } }
  const format = { type: 'json_schema', name: OUTPUT_NAME, strict: true, schema: CONFORMANCE_SCHEMA }
  return {
    text: { ...common, prompt_cache_key: SYSTEM_KEY, input: [{ role: 'system', content: 'You are a test system.' }, user('hello')], text: { format } },
    history: {
      ...common,
      input: [user('first'), { role: 'assistant', content: 'answer' }, user('second')],
      text: { format },
    },
    image: {
      ...common,
      input: [
        user([
          { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}` },
          { type: 'input_text', text: 'Describe it.' },
        ]),
      ],
      text: { format },
    },
    cache: {
      ...common,
      prompt_cache_key: CACHE_SYSTEM_KEY,
      input: [
        { role: 'system', content: 'Stable system part.\n\nSecond system part.' },
        user([
          { type: 'input_text', text: 'Stable user part.' },
          { type: 'input_text', text: 'Volatile user part.' },
        ]),
      ],
      text: { format },
    },
  }
}
