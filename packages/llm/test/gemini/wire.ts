import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PDF_BASE64, PNG_BASE64, type ConformanceGoldens, type ConformanceWire } from '../conformance'
import { createFakeTransport, errorReply, sseReply, type FakeReply, type FakeTransport } from '../fake-transport'
import { GeminiProvider } from '../../src/gemini'

export const GEMINI_MODEL = 'gemini-3.8-flash'
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const GEMINI_MAX_TOKENS = 20_000

export const RAW_USAGE = {
  total_input_tokens: 1000,
  total_cached_tokens: 300,
  total_output_tokens: 400,
  total_thought_tokens: 250,
  total_tool_use_tokens: 0,
  total_tokens: 1650,
}
export const NORMALISED_USAGE = { inputTokens: 700, outputTokens: 650, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 }

export interface WireEvent {
  event: string
  data: Record<string, unknown> | string
}

const interaction = (status: string, model: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'v1_rill_test',
  object: 'interaction',
  status,
  ...(model === null ? {} : { model }),
  ...extra,
})

export const createdEvent = (model: string | null = GEMINI_MODEL): WireEvent => ({
  event: 'interaction.created',
  data: { event_type: 'interaction.created', interaction: interaction('in_progress', model) },
})

export const thoughtEvents = (index: number): WireEvent[] => [
  { event: 'step.start', data: { event_type: 'step.start', index, step: { type: 'thought' } } },
  { event: 'step.delta', data: { event_type: 'step.delta', index, delta: { type: 'thought_signature', signature: 'c2lnbmF0dXJl' } } },
  { event: 'step.stop', data: { event_type: 'step.stop', index } },
]

export const outputEvents = (index: number, chunks: readonly string[]): WireEvent[] => [
  { event: 'step.start', data: { event_type: 'step.start', index, step: { type: 'model_output' } } },
  ...chunks.map((text): WireEvent => ({ event: 'step.delta', data: { event_type: 'step.delta', index, delta: { type: 'text', text } } })),
  { event: 'step.stop', data: { event_type: 'step.stop', index } },
]

export const completedEvent = (status: string, usage: unknown = RAW_USAGE, model: string | null = GEMINI_MODEL, extra: Record<string, unknown> = {}): WireEvent => ({
  event: 'interaction.completed',
  data: { event_type: 'interaction.completed', interaction: interaction(status, model, { ...(usage === null ? {} : { usage }), ...extra }) },
})

export const errorEvent = (code: string, message = 'stream failed'): WireEvent => ({ event: 'error', data: { event_type: 'error', error: { code, message } } })

export const DONE: WireEvent = { event: 'done', data: '[DONE]' }

export function streamEvents(text: string, status = 'completed', usage: unknown = RAW_USAGE, model: string | null = GEMINI_MODEL): WireEvent[] {
  const half = Math.floor(text.length / 2)
  return [createdEvent(model), ...thoughtEvents(0), ...outputEvents(1, [text.slice(0, half), text.slice(half)]), completedEvent(status, usage, model), DONE]
}

export const streamReply = (text: string, status = 'completed', usage: unknown = RAW_USAGE, model: string | null = GEMINI_MODEL): FakeReply =>
  sseReply(streamEvents(text, status, usage, model))

const goldenBody = (extra: Record<string, unknown>) => ({
  model: GEMINI_MODEL,
  ...extra,
  generation_config: { max_output_tokens: GEMINI_MAX_TOKENS },
  response_format: { type: 'text', mime_type: 'application/json', schema: CONFORMANCE_SCHEMA },
  store: false,
  stream: true,
})

export function geminiGoldens(): ConformanceGoldens {
  const text = (value: string) => ({ type: 'text', text: value })
  return {
    text: goldenBody({ system_instruction: 'You are a test system.', input: [text('hello')] }),
    history: goldenBody({
      input: [
        { type: 'user_input', content: [text('first')] },
        { type: 'model_output', content: [text('answer')] },
        { type: 'user_input', content: [text('second')] },
      ],
    }),
    pdf: goldenBody({ input: [{ type: 'document', mime_type: 'application/pdf', data: PDF_BASE64 }, text('Extract the fields.')] }),
    image: goldenBody({ input: [{ type: 'image', mime_type: 'image/png', data: PNG_BASE64 }, text('Describe it.')] }),
    cache: goldenBody({ system_instruction: 'Stable system part.\n\nSecond system part.', input: [text('Stable user part.'), text('Volatile user part.')] }),
  }
}

export function geminiWire(): ConformanceWire {
  const text = JSON.stringify(CONFORMANCE_DATA)
  return {
    mode: 'sse',
    maxTokens: GEMINI_MAX_TOKENS,
    endpoint: GEMINI_ENDPOINT,
    ok: { reply: streamReply(text), data: CONFORMANCE_DATA, usage: NORMALISED_USAGE, model: GEMINI_MODEL, stopReason: 'completed' },
    truncated: { reply: streamReply('{"a":', 'incomplete'), usage: NORMALISED_USAGE },
    refusal: { reply: errorReply(400, { error: { code: 'safety', message: 'Input blocked: the prompt tripped a safety filter' } }) },
    notJson: streamReply('not json'),
    auth: errorReply(401, { error: { code: 'authentication', message: `API key ${CONFORMANCE_API_KEY} was rejected` } }),
    rateLimit: errorReply(429, {
      error: { code: 'rate_limit_exceeded', message: 'slow down', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] },
    }),
    overloaded: errorReply(503, { error: { code: 'service_unavailable', message: 'busy' } }),
    invalidRequest: errorReply(400, { error: { code: 'invalid_request', message: 'the request body is not accepted' } }),
    contextTooLong: errorReply(500, { error: { code: 500, status: 'INTERNAL', message: 'Your input context is too long' } }),
    goldens: geminiGoldens(),
  }
}

export interface GeminiSetup {
  transport: FakeTransport
  provider: GeminiProvider
}

export function geminiSetup(replies: readonly FakeReply[] = [streamReply(JSON.stringify(CONFORMANCE_DATA))], model = GEMINI_MODEL): GeminiSetup {
  const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
  const provider = new GeminiProvider({ model, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random })
  transport.script(...replies)
  return { transport, provider }
}
