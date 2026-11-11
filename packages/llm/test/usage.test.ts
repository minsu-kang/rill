import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, STREAMING_ABOVE_MAX_TOKENS, type LlmRequest } from '../src/index'
import { closeServers, message, mock, provider, request, streamEvents } from './mock'

afterEach(closeServers)

const OPUS_5 = 'claude-opus-5-5'
const OPUS_4 = 'claude-opus-4-8'
const SONNET = 'claude-sonnet-5-5'

interface Entry {
  type: string
  model?: string | null
  input: number
  output: number
  read?: number | null
  created?: number | null
}

const iteration = ({ type, model, input, output, read, created }: Entry): Record<string, unknown> => ({
  type,
  ...(model === undefined ? {} : { model }),
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read === undefined ? 0 : read,
  cache_creation_input_tokens: created === undefined ? 0 : created,
  cache_creation: null,
})

const topLevel = { input_tokens: 900, output_tokens: 90, cache_read_input_tokens: 9, cache_creation_input_tokens: 1 }

function reply(iterations: unknown, overrides: Record<string, unknown> = {}) {
  return message('{"a":1}', {
    model: OPUS_4,
    usage: { ...topLevel, ...(iterations === undefined ? {} : { iterations }) },
    ...overrides,
  })
}

async function run(body: Record<string, unknown>, options: { stream?: boolean } = {}) {
  const { baseURL } = await mock((seen) =>
    seen.body.stream === true ? { sse: { events: streamEvents(body) } } : { body },
  )
  const call: LlmRequest = options.stream === true ? { ...request, maxTokens: STREAMING_ABOVE_MAX_TOKENS + 1 } : request
  return provider(baseURL).generate(call)
}

const declined = iteration({ type: 'message', model: OPUS_5, input: 100, output: 0, read: 40, created: 10 })
const served = iteration({ type: 'fallback_message', model: OPUS_4, input: 110, output: 30, read: 5, created: 2 })

describe('usage under a fallback', () => {
  it('sums every iteration for the totals instead of using the top-level counters', async () => {
    const result = await run(reply([declined, served]))
    expect(result.usage).toEqual({ inputTokens: 210, outputTokens: 30, cacheReadInputTokens: 45, cacheCreationInputTokens: 12 })
    expect(result).toMatchObject({ fallbackUsed: true, model: OPUS_4, requestedModel: DEFAULT_MODEL })
  })

  it('lists the model that served the reply, and only it when the declined hop wrote nothing', async () => {
    expect((await run(reply([declined, served]))).servedModels).toEqual([OPUS_4])
  })

  it('lists models of iterations that produced output, last one first', async () => {
    const wrote = iteration({ type: 'message', model: OPUS_5, input: 100, output: 12 })
    expect((await run(reply([wrote, served]))).servedModels).toEqual([OPUS_4, OPUS_5])
    const middle = iteration({ type: 'message', model: SONNET, input: 100, output: 3 })
    expect((await run(reply([wrote, middle, served]))).servedModels).toEqual([OPUS_4, SONNET, OPUS_5])
  })

  it('lists a model once even when several iterations ran on it', async () => {
    const again = iteration({ type: 'message', model: OPUS_4, input: 5, output: 5 })
    const result = await run(reply([again, again, served]))
    expect(result.servedModels).toEqual([OPUS_4])
    expect(result.usage.inputTokens).toBe(5 + 5 + 110)
  })

  it('counts compaction and advisor iterations in the totals but not as serving models', async () => {
    const compaction = iteration({ type: 'compaction', input: 1000, output: 100, read: 7, created: 3 })
    const advisor = iteration({ type: 'advisor_message', model: SONNET, input: 20, output: 8 })
    const result = await run(reply([compaction, advisor, declined, served]))
    expect(result.usage).toEqual({ inputTokens: 1230, outputTokens: 138, cacheReadInputTokens: 52, cacheCreationInputTokens: 15 })
    expect(result.servedModels).toEqual([OPUS_4])
  })

  it('skips iterations without a model and reads missing cache counters as zero', async () => {
    const anonymous = iteration({ type: 'message', model: null, input: 10, output: 10 })
    const sparse = { type: 'fallback_message', model: OPUS_4, input_tokens: 4, output_tokens: 6 }
    const result = await run(reply([anonymous, sparse]))
    expect(result.servedModels).toEqual([OPUS_4])
    expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 16, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    const nulls = iteration({ type: 'fallback_message', model: OPUS_4, input: 4, output: 6, read: null, created: null })
    expect((await run(reply([nulls]))).usage).toEqual({ inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  it('falls back to the reply model when no iteration produced output', async () => {
    const silent = iteration({ type: 'message', model: OPUS_5, input: 10, output: 0 })
    const result = await run(reply([silent]))
    expect(result.servedModels).toEqual([OPUS_4])
    expect(result.usage.inputTokens).toBe(10)
  })

  it('ignores entries that are not usable and sums the rest', async () => {
    const entries = [null, 'x', 7, [], {}, { type: 'message' }, { input_tokens: '5', output_tokens: 1 }, { input_tokens: 5, output_tokens: -1 }, declined, served]
    const result = await run(reply(entries))
    expect(result.usage).toEqual({ inputTokens: 210, outputTokens: 30, cacheReadInputTokens: 45, cacheCreationInputTokens: 12 })
    expect(result.servedModels).toEqual([OPUS_4])
  })
})

describe('usage without usable iterations', () => {
  const expected = { inputTokens: 900, outputTokens: 90, cacheReadInputTokens: 9, cacheCreationInputTokens: 1 }

  it.each<[string, unknown]>([
    ['absent iterations', undefined],
    ['null iterations', null],
    ['an empty list', []],
    ['a value that is not a list', { type: 'message' }],
    ['a list without counters', [{ type: 'message' }, { type: 'fallback_message' }]],
    ['a list of garbage', [null, 'x', 3]],
  ])('keeps the top-level counters and the reply model for %s', async (_name, iterations) => {
    const result = await run(reply(iterations))
    expect(result.usage).toEqual(expected)
    expect(result.servedModels).toEqual([OPUS_4])
  })

  it('reports the model of an ordinary reply as the only served model', async () => {
    const result = await run(message('{"a":1}', { model: SONNET }))
    expect(result.servedModels).toEqual([SONNET])
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 })
    expect(result.fallbackUsed).toBe(false)
  })

  it('still flags a fallback that only the iteration types show', async () => {
    expect((await run(reply([{ type: 'message' }, { type: 'fallback_message' }]))).fallbackUsed).toBe(true)
    expect((await run(reply([null, 'x]']))).fallbackUsed).toBe(false)
  })
})

describe('usage in a streamed reply', () => {
  it('sums the iterations of the final message_delta and lists the serving model', async () => {
    const streamed = await run(reply([declined, served]), { stream: true })
    const buffered = await run(reply([declined, served]))
    expect(streamed.usage).toEqual({ inputTokens: 210, outputTokens: 30, cacheReadInputTokens: 45, cacheCreationInputTokens: 12 })
    expect(streamed.servedModels).toEqual([OPUS_4])
    expect({ ...streamed, durationMs: 0 }).toEqual({ ...buffered, durationMs: 0 })
  })

  it('keeps the top-level counters when a streamed reply carries no iterations', async () => {
    const result = await run(reply(undefined), { stream: true })
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 90, cacheReadInputTokens: 9, cacheCreationInputTokens: 1 })
    expect(result.servedModels).toEqual([OPUS_4])
  })
})
