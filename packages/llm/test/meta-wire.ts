import type { ConformanceGoldens, ConformanceWire } from './conformance'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PDF_BASE64, PNG_BASE64, RETRY_AFTER_MS } from './conformance'
import { errorReply, sseReply, type FakeReply } from './fake-transport'

export const META_CHAT_URL = 'https://api.meta.ai/v1/chat/completions'
export const META_TEST_MODEL = 'muse-spark-1.3'
export const META_MAX_TOKENS = 8000

export const SYSTEM_KEY = 'rill-d60713d238725fdc'
export const CACHE_SYSTEM_KEY = 'rill-0e2767fb2d17e033'

export interface MetaUsageFixture {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number | null }
  completion_tokens_details?: { reasoning_tokens?: number | null }
}

export const RAW_USAGE: MetaUsageFixture = {
  prompt_tokens: 1000,
  completion_tokens: 650,
  total_tokens: 1650,
  prompt_tokens_details: { cached_tokens: 300 },
  completion_tokens_details: { reasoning_tokens: 250 },
}

export const NORMALISED_USAGE = { inputTokens: 700, outputTokens: 650, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 }

type Chunk = { event?: string; data: unknown }

const base = (model: string) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model })

export function chatChunks(
  content: string,
  options: { finish?: string | null; usage?: MetaUsageFixture | null; model?: string; refusal?: string; done?: boolean } = {},
): Chunk[] {
  const model = options.model ?? META_TEST_MODEL
  const finish = options.finish === undefined ? 'stop' : options.finish
  const usage = options.usage === undefined ? RAW_USAGE : options.usage
  const half = Math.floor(content.length / 2)
  const out: Chunk[] = [{ data: { ...base(model), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } }]
  if (content !== '') {
    out.push({ data: { ...base(model), choices: [{ index: 0, delta: { content: content.slice(0, half) }, finish_reason: null }] } })
    out.push({ data: { ...base(model), choices: [{ index: 0, delta: { content: content.slice(half) }, finish_reason: null }] } })
  }
  if (options.refusal !== undefined) {
    out.push({ data: { ...base(model), choices: [{ index: 0, delta: { refusal: options.refusal }, finish_reason: null }] } })
  }
  if (finish !== null) out.push({ data: { ...base(model), choices: [{ index: 0, delta: {}, finish_reason: finish }] } })
  if (usage !== null) out.push({ data: { ...base(model), choices: [], usage } })
  if (options.done !== false) out.push({ data: '[DONE]' })
  return out
}

export const chatReply = (content: string, options: Parameters<typeof chatChunks>[1] = {}, then: 'end' | 'hold' | 'drop' = 'end'): FakeReply =>
  sseReply(chatChunks(content, options), then)

export const okReply = (): FakeReply => chatReply(JSON.stringify(CONFORMANCE_DATA))

const user = (content: unknown) => ({ role: 'user', content })

const common = {
  model: META_TEST_MODEL,
  response_format: { type: 'json_schema', json_schema: { name: 'rill_output', strict: false, schema: CONFORMANCE_SCHEMA } },
  reasoning_effort: 'high',
  max_completion_tokens: META_MAX_TOKENS,
  stream: true,
  stream_options: { include_usage: true },
}

export const metaGoldens: ConformanceGoldens = {
  text: { ...common, prompt_cache_key: SYSTEM_KEY, messages: [{ role: 'developer', content: 'You are a test system.' }, user('hello')] },
  history: {
    ...common,
    messages: [user('first'), { role: 'assistant', content: 'answer' }, user('second')],
  },
  pdf: {
    ...common,
    messages: [
      user([
        { type: 'file', file: { filename: 'document-1.pdf', file_data: `data:application/pdf;base64,${PDF_BASE64}` } },
        { type: 'text', text: 'Extract the fields.' },
      ]),
    ],
  },
  image: {
    ...common,
    messages: [
      user([
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        { type: 'text', text: 'Describe it.' },
      ]),
    ],
  },
  cache: {
    ...common,
    prompt_cache_key: CACHE_SYSTEM_KEY,
    messages: [
      { role: 'developer', content: 'Stable system part.\n\nSecond system part.' },
      user([
        { type: 'text', text: 'Stable user part.' },
        { type: 'text', text: 'Volatile user part.' },
      ]),
    ],
  },
}

export const metaError = (status: number, message: string, type: string, code: string | null, headers: Record<string, string> = {}): FakeReply =>
  errorReply(status, { error: { message, type, param: null, code } }, headers)

export const metaWire: ConformanceWire = {
  mode: 'sse',
  maxTokens: META_MAX_TOKENS,
  endpoint: META_CHAT_URL,
  ok: { reply: okReply(), data: CONFORMANCE_DATA, usage: NORMALISED_USAGE, model: META_TEST_MODEL, stopReason: 'stop' },
  truncated: { reply: chatReply('{"a":', { finish: 'length' }), usage: NORMALISED_USAGE },
  refusal: { reply: chatReply('', { finish: 'content_filter' }), usage: NORMALISED_USAGE },
  notJson: chatReply('not json'),
  auth: metaError(401, `Invalid API key ${CONFORMANCE_API_KEY}`, 'authentication_error', 'invalid_api_key'),
  rateLimit: metaError(429, 'Rate limit exceeded', 'rate_limit_error', 'rate_limit_exceeded', { 'retry-after': String(RETRY_AFTER_MS / 1000) }),
  overloaded: metaError(503, 'The service is overloaded', 'server_error', 'service_overloaded'),
  invalidRequest: metaError(400, 'the schema is not accepted', 'invalid_request_error', null),
  contextTooLong: metaError(400, "This request has 1200000 tokens, but the model's context length is only 1048576 tokens", 'invalid_request_error', null),
  goldens: metaGoldens,
}
