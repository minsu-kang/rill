import type { ConformanceGoldens, ConformanceWire } from './conformance'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PDF_BASE64, PNG_BASE64, RETRY_AFTER_MS } from './conformance'
import { errorReply, jsonReply, sseReply, type FakeReply } from './fake-transport'
import { REFERENCE_ENDPOINT, REFERENCE_MODEL } from './reference-provider'

const RAW_USAGE = { prompt: 1000, cached: 300, written: 200, output: 400, thought: 250 }
const USAGE = { inputTokens: 500, outputTokens: 650, cacheReadInputTokens: 300, cacheCreationInputTokens: 200 }

const final = (status: 'done' | 'cut' | 'refused', text: string) => ({ model: REFERENCE_MODEL, status, text, usage: RAW_USAGE })

function replyOf(streaming: boolean, status: 'done' | 'cut' | 'refused', text: string): FakeReply {
  if (!streaming) return jsonReply(final(status, text))
  const half = Math.floor(text.length / 2)
  return sseReply([
    { data: { type: 'start' } },
    { data: { type: 'delta', text: text.slice(0, half) } },
    { data: { type: 'delta', text: text.slice(half) } },
    { data: { type: 'done', ...final(status, text) } },
  ])
}

export type ReferenceVariant = 'full' | 'plain'

export function referenceWire(streaming: boolean, variant: ReferenceVariant = 'full'): ConformanceWire {
  const text = JSON.stringify(CONFORMANCE_DATA)
  return {
    mode: streaming ? 'sse' : 'json',
    maxTokens: streaming ? 20_000 : 4000,
    endpoint: REFERENCE_ENDPOINT,
    ok: { reply: replyOf(streaming, 'done', text), data: CONFORMANCE_DATA, usage: USAGE, model: REFERENCE_MODEL, stopReason: 'done' },
    truncated: { reply: replyOf(streaming, 'cut', '{"a":'), usage: USAGE },
    refusal: { reply: replyOf(streaming, 'refused', ''), usage: USAGE },
    notJson: replyOf(streaming, 'done', 'not json'),
    auth: errorReply(401, { error: { message: `Invalid key ${CONFORMANCE_API_KEY}` } }),
    rateLimit: errorReply(429, { error: { message: 'slow down' } }, { 'retry-after': String(RETRY_AFTER_MS / 1000) }),
    overloaded: errorReply(503, { error: { message: 'busy' } }),
    invalidRequest: errorReply(400, { error: { message: 'the schema is not accepted' } }),
    contextTooLong: errorReply(400, { error: { message: 'the context length is exceeded: input too long' } }),
    goldens: referenceGoldens(streaming, variant),
  }
}

const system = [{ text: 'You are a test system.' }]
const stream = (streaming: boolean) => ({ stream: streaming, max_tokens: streaming ? 20_000 : 4000 })

export function referenceGoldens(streaming: boolean, variant: ReferenceVariant): ConformanceGoldens {
  const common = { model: REFERENCE_MODEL, ...stream(streaming), format: CONFORMANCE_SCHEMA }
  const flagged = variant === 'full'
  return {
    text: { ...common, system, input: [{ role: 'user', content: 'hello' }] },
    history: {
      ...common,
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    },
    ...(variant === 'plain' ? {} : { pdf: {
      ...common,
      input: [
        {
          role: 'user',
          content: [
            { type: 'pdf', data: PDF_BASE64 },
            { type: 'text', text: 'Extract the fields.' },
          ],
        },
      ],
    } }),
    image: {
      ...common,
      input: [
        {
          role: 'user',
          content: [
            { type: 'image', media_type: 'image/png', data: PNG_BASE64 },
            { type: 'text', text: 'Describe it.' },
          ],
        },
      ],
    },
    cache: {
      ...common,
      system: [{ text: 'Stable system part.', ...(flagged ? { cache: true } : {}) }, { text: 'Second system part.' }],
      input: [
        { role: 'user', content: [{ type: 'text', text: 'Stable user part.', ...(flagged ? { cache: true } : {}) }, { type: 'text', text: 'Volatile user part.' }] },
      ],
      ...(flagged ? { cache: true } : {}),
    },
  }
}
