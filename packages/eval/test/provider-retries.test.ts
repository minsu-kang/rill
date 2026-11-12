import { describe, expect, it } from 'vitest'
import { createSpecProvider } from '../src/providers'
import { runEval, worstCaseCallUsd } from '../src/runner'
import type { EvalCase, Suite } from '../src/suite'

const FIRST_EVENT: Record<string, string> = {
  openai: 'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","status":"in_progress","output":[],"usage":null,"model":"gpt-6-luna"}}\n\n',
  grok: 'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","status":"in_progress","output":[],"usage":null,"model":"grok-4.3"}}\n\n',
  meta: 'data: {"id":"c","object":"chat.completion.chunk","model":"muse-spark-1.3","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"a\\":"}}]}\n\n',
  gemini: 'data: {"event_type":"interaction.created","interaction":{"id":"i","status":"in_progress","model":"gemini-3.8-flash"}}\n\n',
}

function droppedStream(provider: string): Response {
  const event = new TextEncoder().encode(FIRST_EVENT[provider])
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < 5; sent += 1) controller.enqueue(event)
      setTimeout(() => controller.error(new TypeError('terminated')), 10)
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const busy = (): Response => new Response(JSON.stringify({ error: { message: 'busy', code: 'server_is_overloaded' } }), { status: 503, headers: { 'content-type': 'application/json' } })

const SPECS = ['openai:gpt-6-luna', 'grok:grok-4.3', 'meta:muse-spark-1.3', 'gemini:gemini-3.8-flash']
const ask = { messages: [{ role: 'user' as const, content: 'hi' }], schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }

describe.each(SPECS)('%s through the eval provider', (spec) => {
  const id = spec.slice(0, spec.indexOf(':'))

  it('sends one request for an attempt whose stream drops after some events, so the runner sees every billed exchange', async () => {
    let calls = 0
    const { provider, recorder } = createSpecProvider({ model: spec, apiKey: 'key-123456789', maxTokens: 20_000, fetch: async () => (calls += 1, droppedStream(id)) })
    await expect(provider.generate(ask)).rejects.toMatchObject({ kind: 'connection' })
    expect(calls).toBe(1)
    expect(recorder.exchanges()).toHaveLength(1)
  })

  it('leaves retrying a busy server to the runner', async () => {
    let calls = 0
    const { provider } = createSpecProvider({ model: spec, apiKey: 'key-123456789', maxTokens: 20_000, fetch: async () => (calls += 1, busy()) })
    await expect(provider.generate(ask)).rejects.toMatchObject({ kind: 'overloaded' })
    expect(calls).toBe(1)
  })
})

describe('runner ledger for a dropped billed stream', () => {
  it('charges at least one assumed worst case for every request that was sent', async () => {
    const cases: EvalCase[] = [{ id: 'a', group: 'a', category: 'easy', tags: [], kind: 'text' }]
    const suite: Suite<EvalCase, string> = {
      name: 'fake',
      version: '1',
      fields: ['x'],
      cases: () => cases,
      run: async (_case, ctx) => {
        await ctx.provider.generate(ask)
        return 'x'
      },
      score: () => ({ status: 'ok', outcomes: { x: 'TP' }, extra: {} }),
      estimateInputTokens: () => 1000,
    }
    let calls = 0
    const result = await runEval({
      suite,
      models: ['grok:grok-4.3'],
      reps: 1,
      concurrency: 1,
      seed: 1,
      maxAttempts: 3,
      budgetUsd: 10,
      sleep: async () => undefined,
      random: () => 0,
      createProvider: (model, signal, settings) =>
        createSpecProvider({ model, signal, apiKey: 'xai-key-123456', maxTokens: settings.maxOutputTokens, fetch: async () => (calls += 1, droppedStream('grok')) }),
    })
    const worst = worstCaseCallUsd(suite, cases[0]!, 'grok:grok-4.3', 16_000)!
    expect(calls).toBe(3)
    expect(result.tasks[0]?.exchanges).toHaveLength(1)
    expect(result.spentUsd).toBeGreaterThanOrEqual(worst * calls - 1e-9)
  })
})
