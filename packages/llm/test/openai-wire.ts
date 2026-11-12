import type { ConformanceGoldens, ConformanceWire } from './conformance'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PDF_BASE64, PNG_BASE64, RETRY_AFTER_MS } from './conformance'
import { errorReply, jsonReply, sseReply, type FakeReply } from './fake-transport'

export const OPENAI_MODEL = 'gpt-6.1-sol'
export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'
export const SCHEMA_NAME = 'rill_output'

export const RAW_USAGE = {
  input_tokens: 9800,
  input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 },
  output_tokens: 1450,
  output_tokens_details: { reasoning_tokens: 1350 },
  total_tokens: 11250,
}
export const USAGE = { inputTokens: 9300, outputTokens: 1450, cacheReadInputTokens: 300, cacheCreationInputTokens: 200 }

export type Shape = 'completed' | 'cut' | 'refused' | 'filtered'

export function responseBody(shape: Shape, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const refused = shape === 'refused'
  const content = refused ? [{ type: 'refusal', refusal: 'I cannot help with that.' }] : [{ type: 'output_text', text, annotations: [] }]
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1_790_000_000,
    model: OPENAI_MODEL,
    status: shape === 'cut' || shape === 'filtered' ? 'incomplete' : 'completed',
    incomplete_details: shape === 'cut' ? { reason: 'max_output_tokens' } : shape === 'filtered' ? { reason: 'content_filter' } : null,
    error: null,
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', id: 'msg_1', role: 'assistant', status: shape === 'cut' ? 'incomplete' : 'completed', content },
    ],
    usage: RAW_USAGE,
    ...extra,
  }
}

export function streamEvents(response: Record<string, unknown>): { event: string; data: unknown }[] {
  const terminal = response.status === 'incomplete' ? 'response.incomplete' : response.status === 'failed' ? 'response.failed' : 'response.completed'
  const items = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : []
  const message = items.find((item) => item.type === 'message')
  const parts = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
  const text = typeof parts[0]?.text === 'string' ? parts[0].text : ''
  const half = Math.floor(text.length / 2)
  let sequence = 0
  const at = (event: string, data: Record<string, unknown>) => ({ event, data: { type: event, sequence_number: sequence++, ...data } })
  return [
    at('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } }),
    at('response.in_progress', { response: { ...response, status: 'in_progress', output: [], usage: null } }),
    at('response.output_item.added', { output_index: 0, item: items[0] }),
    at('response.output_item.done', { output_index: 0, item: items[0] }),
    at('response.output_item.added', { output_index: 1, item: { ...message, content: [] } }),
    ...(text === ''
      ? []
      : [
          at('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(0, half) }),
          at('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(half) }),
          at('response.output_text.done', { item_id: 'msg_1', output_index: 1, content_index: 0, text }),
        ]),
    at('response.output_item.done', { output_index: 1, item: message }),
    at(terminal, { response }),
  ]
}

export function replyOf(streaming: boolean, shape: Shape, text: string): FakeReply {
  const body = responseBody(shape, text)
  return streaming ? sseReply(streamEvents(body)) : jsonReply(body)
}

const apiError = (message: string, extra: Record<string, unknown> = {}) => ({ error: { message, type: 'invalid_request_error', param: null, code: null, ...extra } })

export const AUTH_REPLY = errorReply(401, apiError(`Incorrect API key provided: ${CONFORMANCE_API_KEY}.`, { code: 'invalid_api_key' }))

const system = (text: string, flagged = false) => ({ type: 'input_text', text, ...(flagged ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}) })
const developer = (...blocks: unknown[]) => ({ role: 'developer', content: blocks })
const BREAKPOINT = { prompt_cache_breakpoint: { mode: 'explicit' } }

export function openaiGoldens(streaming: boolean): ConformanceGoldens {
  const common = {
    model: OPENAI_MODEL,
    store: false,
    max_output_tokens: streaming ? 20_000 : 4000,
    ...(streaming ? { stream: true } : {}),
    text: { format: { type: 'json_schema', name: SCHEMA_NAME, strict: true, schema: CONFORMANCE_SCHEMA } },
  }
  return {
    text: { ...common, input: [developer(system('You are a test system.')), { role: 'user', content: 'hello' }] },
    history: {
      ...common,
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    },
    pdf: {
      ...common,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_file', filename: 'document-1.pdf', file_data: `data:application/pdf;base64,${PDF_BASE64}` },
            { type: 'input_text', text: 'Extract the fields.' },
          ],
        },
      ],
    },
    image: {
      ...common,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}`, detail: 'auto' },
            { type: 'input_text', text: 'Describe it.' },
          ],
        },
      ],
    },
    cache: {
      ...common,
      input: [
        developer(system('Stable system part.', true), system('Second system part.')),
        { role: 'user', content: [{ type: 'input_text', text: 'Stable user part.', ...BREAKPOINT }, { type: 'input_text', text: 'Volatile user part.' }] },
      ],
    },
  }
}

export function openaiWire(streaming: boolean): ConformanceWire {
  const text = JSON.stringify(CONFORMANCE_DATA)
  return {
    mode: streaming ? 'sse' : 'json',
    maxTokens: streaming ? 20_000 : 4000,
    endpoint: OPENAI_ENDPOINT,
    ok: { reply: replyOf(streaming, 'completed', text), data: CONFORMANCE_DATA, usage: USAGE, model: OPENAI_MODEL, stopReason: 'end_turn' },
    truncated: { reply: replyOf(streaming, 'cut', '{"a":'), usage: USAGE },
    refusal: { reply: replyOf(streaming, 'refused', ''), usage: USAGE },
    notJson: replyOf(streaming, 'completed', 'not json'),
    auth: AUTH_REPLY,
    rateLimit: errorReply(429, apiError('Rate limit reached for requests', { type: 'rate_limit_error' }), { 'retry-after': String(RETRY_AFTER_MS / 1000) }),
    overloaded: errorReply(503, apiError('The server is overloaded.', { type: 'service_unavailable_error', code: 'server_is_overloaded' })),
    invalidRequest: errorReply(400, apiError('the schema is not accepted', { param: 'text.format.schema' })),
    contextTooLong: errorReply(400, apiError('the input is too long for this model', { param: 'input' })),
    goldens: openaiGoldens(streaming),
  }
}
