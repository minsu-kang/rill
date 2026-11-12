import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerDescriptor } from '@rill/llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { okReply as grokReply } from '../../llm/test/grok/wire'
import { streamReply as geminiReply } from '../../llm/test/gemini/wire'
import { replyOf as openaiReply } from '../../llm/test/openai-wire'
import { chatReply as metaReply } from '../../llm/test/meta-wire'
import { createFakeTransport, jsonReply, type FakeReply, type FakeTransport } from '../../llm/test/fake-transport'
import { main, type CliIo } from '../src/cli'
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli-shared'
import { CHECK_CALL_NAMES, evaluateLiveChecks, parseCheckProviderArgs, rawUsageOf, rawUsageNumbers, tinyPdf, type CallRecord, type Measurements } from '../src/check-provider'
import { PRICE_TABLE_AS_OF } from '../src/pricing'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-check-provider-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const KEYS = { anthropic: 'sk-ant-CHECK-SECRET-1', openai: 'sk-openai-CHECK-SECRET-2', gemini: 'gemini-CHECK-SECRET-3', grok: 'xai-CHECK-SECRET-4', meta: 'meta-CHECK-SECRET-5' } as const
const ENV_OF = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', grok: 'XAI_API_KEY', meta: 'META_API_KEY' } as const

const WORD = '{"word":"rill","count":3}'
const REPLIES: Record<string, FakeReply> = {
  anthropic: jsonReply({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: WORD }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
  }),
  openai: openaiReply(false, 'completed', '{"word":"rill","count":3,"note":null}'),
  gemini: geminiReply(WORD),
  grok: grokReply({ text: WORD }),
  meta: metaReply(WORD),
}

const MODELS = { anthropic: 'claude-haiku-5-5', openai: 'gpt-6.1-sol', gemini: 'gemini-3.8-flash', grok: 'grok-4.7', meta: 'muse-spark-1.3' } as const

type ProviderKey = keyof typeof MODELS

function setup(provider: ProviderKey, extraArgs: string[] = [], env: Record<string, string> | undefined = undefined) {
  const transport: FakeTransport = createFakeTransport()
  transport.script(REPLIES[provider]!)
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    env: env ?? { [ENV_OF[provider]]: KEYS[provider] },
    now: () => Date.UTC(2026, 10, 13, 9, 30, 0),
    checkProvider: { fetch: transport.fetch },
  }
  const run = (...args: string[]) => main(['check-provider', '--provider', provider, '--model', MODELS[provider], ...args, ...extraArgs], io)
  return { transport, io, run, out: () => out.join(''), err: () => err.join('') }
}

describe('parseCheckProviderArgs', () => {
  it('reads the provider, the model, the budget and the mode', () => {
    expect(parseCheckProviderArgs(['--provider', 'openai', '--model', 'gpt-6.1-sol'])).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', budgetUsd: 0.25, yes: false, dry: false })
    expect(parseCheckProviderArgs(['--provider', 'grok', '--model', 'grok-4.7', '--budget-usd', '1.5', '--yes'])).toMatchObject({ budgetUsd: 1.5, yes: true })
  })

  it('refuses a missing or unknown provider and a missing model, naming what is allowed', () => {
    expect(() => parseCheckProviderArgs([])).toThrow(/--provider is required/)
    expect(() => parseCheckProviderArgs(['--provider', 'mistral', '--model', 'x'])).toThrow(/unknown provider 'mistral'/)
    expect(() => parseCheckProviderArgs(['--provider', 'grok'])).toThrow(/--model is required.*grok-4\.7/)
  })

  it('refuses --yes with --dry, a bad budget and an unknown model', () => {
    expect(() => parseCheckProviderArgs(['--provider', 'grok', '--model', 'grok-4.7', '--yes', '--dry'])).toThrow(/cannot be combined/)
    expect(() => parseCheckProviderArgs(['--provider', 'grok', '--model', 'grok-4.7', '--budget-usd', 'lots'])).toThrow(/--budget-usd must be/)
    expect(() => parseCheckProviderArgs(['--provider', 'openai', '--model', 'gpt-9'])).toThrow(/unknown model 'gpt-9'/)
  })
})

describe('raw usage helpers', () => {
  it('finds the usage object in a JSON reply, a stream and a nested terminal event', () => {
    expect(rawUsageOf('{"id":"a","usage":{"input_tokens":5}}')).toEqual({ input_tokens: 5 })
    expect(rawUsageOf('data: {"type":"x"}\n\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":9}}}\n\n')).toEqual({ total_tokens: 9 })
    expect(rawUsageOf('data: {"event_type":"interaction.completed","interaction":{"usage":{"total_input_tokens":7}}}\n\ndata: [DONE]\n\n')).toEqual({ total_input_tokens: 7 })
    expect(rawUsageOf('not json')).toBeUndefined()
  })

  it('reads the token counts of every vendor by name', () => {
    expect(rawUsageNumbers({ input_tokens: 9800, input_tokens_details: { cached_tokens: 300 }, output_tokens: 1450, output_tokens_details: { reasoning_tokens: 1350 }, total_tokens: 11250 })).toEqual({ input: 9800, cached: 300, output: 1450, reasoning: 1350, total: 11250 })
    expect(rawUsageNumbers({ total_input_tokens: 1000, total_cached_tokens: 300, total_output_tokens: 400, total_thought_tokens: 250, total_tokens: 1650 })).toEqual({ input: 1000, cached: 300, output: 400, reasoning: 250, total: 1650 })
    expect(rawUsageNumbers({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 300 }, completion_tokens: 650, completion_tokens_details: { reasoning_tokens: 250 }, total_tokens: 1650 })).toEqual({ input: 1000, cached: 300, output: 650, reasoning: 250, total: 1650 })
    expect(rawUsageNumbers({})).toEqual({})
  })

  it('builds a PDF with a cross reference table whose offsets are right', () => {
    const pdf = tinyPdf().toString('latin1')
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    const xref = pdf.indexOf('\nxref\n')
    const entries = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) => Number(match[1]))
    expect(entries.length).toBeGreaterThan(3)
    for (const [index, offset] of entries.entries()) expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true)
    expect(pdf).toContain('/Type /Page')
    expect(Buffer.byteLength(pdf)).toBeLessThan(2000)
  })
})

describe('evaluateLiveChecks', () => {
  const base: Measurements = {
    spec: 'x:y',
    requestedModel: 'y',
    prefixTokens: 5000,
    calls: Object.fromEntries(CHECK_CALL_NAMES.map((name) => [name, { name, status: 'not-run', reason: 'test' }])) as Measurements['calls'],
  }
  const ok = (extra: Partial<CallRecord> = {}): CallRecord => ({
    name: 'text',
    status: 'ok',
    data: { word: 'rill', count: 3 },
    dataValid: true,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    ...extra,
  })

  it('gives every id of the provider an entry, UNKNOWN when it is not measured', () => {
    const results = evaluateLiveChecks([{ id: 'schema-error-code', what: 'x' }, { id: 'never-heard-of', what: 'y' }], base)
    expect(results.map((entry) => [entry.id, entry.status])).toEqual([['schema-error-code', 'UNKNOWN'], ['never-heard-of', 'UNKNOWN']])
    expect(results[1]?.measured).toMatch(/not measured by check-provider/)
  })

  it('passes the PDF checks on a PDF call that returned valid data and fails them on an error', () => {
    const pass = evaluateLiveChecks([{ id: 'pdf-schema-reasoning', what: '' }], { ...base, calls: { ...base.calls, pdf: ok({ name: 'pdf' }) } })
    expect(pass[0]).toMatchObject({ status: 'PASS' })
    const fail = evaluateLiveChecks([{ id: 'pdf-schema-reasoning', what: '' }], { ...base, calls: { ...base.calls, pdf: { name: 'pdf', status: 'error', error: { kind: 'invalid_request', message: 'bad schema' } } } })
    expect(fail[0]).toMatchObject({ status: 'FAIL' })
    expect(fail[0]?.measured).toContain('bad schema')
    const unknown = evaluateLiveChecks([{ id: 'pdf-schema-reasoning', what: '' }], base)
    expect(unknown[0]).toMatchObject({ status: 'UNKNOWN' })
  })

  it('reads the cache on the repeated call', () => {
    const repeat = ok({ name: 'repeat', usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 4000, cacheCreationInputTokens: 0 } })
    const none = ok({ name: 'repeat' })
    expect(evaluateLiveChecks([{ id: 'cache-hit', what: '' }], { ...base, calls: { ...base.calls, repeat } })[0]).toMatchObject({ status: 'PASS' })
    expect(evaluateLiveChecks([{ id: 'cache-hit', what: '' }], { ...base, calls: { ...base.calls, repeat: none } })[0]).toMatchObject({ status: 'FAIL' })
    expect(evaluateLiveChecks([{ id: 'cache-minimum-and-ttl', what: '' }], { ...base, calls: { ...base.calls, repeat: none } })[0]).toMatchObject({ status: 'UNKNOWN' })
  })

  it('checks the usage arithmetic against the raw numbers', () => {
    const withRaw = (raw: object) => ({ ...base, calls: { ...base.calls, repeat: ok({ name: 'repeat', raw }) } })
    expect(evaluateLiveChecks([{ id: 'usage-output-total', what: '' }], withRaw({ input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 150 }))[0]).toMatchObject({ status: 'PASS' })
    expect(evaluateLiveChecks([{ id: 'usage-output-total', what: '' }], withRaw({ input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 120 }))[0]).toMatchObject({ status: 'FAIL' })
    expect(evaluateLiveChecks([{ id: 'usage-output-total', what: '' }], withRaw({ input_tokens: 100, output_tokens: 10, total_tokens: 110 }))[0]).toMatchObject({ status: 'UNKNOWN' })
    expect(evaluateLiveChecks([{ id: 'usage-cached-subset', what: '' }], withRaw({ input_tokens: 100, input_tokens_details: { cached_tokens: 60 } }))[0]).toMatchObject({ status: 'PASS' })
    expect(evaluateLiveChecks([{ id: 'usage-cached-subset', what: '' }], withRaw({ input_tokens: 100, input_tokens_details: { cached_tokens: 160 } }))[0]).toMatchObject({ status: 'FAIL' })
    expect(evaluateLiveChecks([{ id: 'usage-thoughts-separate', what: '' }], withRaw({ total_input_tokens: 10, total_output_tokens: 20, total_thought_tokens: 30, total_tokens: 60 }))[0]).toMatchObject({ status: 'PASS' })
    expect(evaluateLiveChecks([{ id: 'cache-write-unreported', what: '' }], withRaw({ input_tokens: 1, cache_creation_input_tokens: 5 }))[0]).toMatchObject({ status: 'FAIL' })
    expect(evaluateLiveChecks([{ id: 'cache-write-unreported', what: '' }], withRaw({ input_tokens: 1 }))[0]).toMatchObject({ status: 'PASS' })
  })

  it('compares the served model with the requested one', () => {
    const served = (model: string) => ({ ...base, calls: { ...base.calls, text: ok({ servedModel: model }) } })
    expect(evaluateLiveChecks([{ id: 'served-model-id', what: '' }], served('y'))[0]).toMatchObject({ status: 'PASS' })
    expect(evaluateLiveChecks([{ id: 'served-model-id', what: '' }], served('z-2026'))[0]).toMatchObject({ status: 'FAIL' })
  })
})

describe('check-provider --dry', () => {
  it('prints the plan, the cost and every live check as not run, and sends nothing', async () => {
    const h = setup('openai', ['--dry'])
    expect(await h.run()).toBe(EXIT_OK)
    const text = h.out()
    expect(text).toContain('check-provider: openai:gpt-6.1-sol (OpenAI)')
    expect(text).toContain('prices as of ' + PRICE_TABLE_AS_OF)
    expect(text).toMatch(/call 1 of 4: text \+ schema with an optional field/)
    expect(text).toMatch(/worst case \$[\d.]+/)
    expect(text).toMatch(/UNKNOWN\s+pdf-schema-reasoning/)
    expect(text).toContain('Nothing was sent.')
    expect(h.transport.requests).toHaveLength(0)
  })

  it('needs no key, and says a model that reads no PDF refuses it without a call', async () => {
    const h = setup('grok', ['--dry'], {})
    expect(await h.run()).toBe(EXIT_OK)
    expect(h.out()).toContain('call 4 of 4: PDF')
    expect(h.out()).toMatch(/PDF.*refused before any request/)
  })

  it('is what you get without --yes', async () => {
    const h = setup('gemini')
    expect(await h.run()).toBe(EXIT_OK)
    expect(h.out()).toContain('Nothing was sent.')
    expect(h.transport.requests).toHaveLength(0)
  })
})

describe('check-provider --yes', () => {
  const PROVIDERS: ProviderKey[] = ['openai', 'gemini', 'grok', 'meta', 'anthropic']

  for (const provider of PROVIDERS) {
    it(`runs the calls against ${provider}, prints measurements and a verdict per live check, and keeps the key out of the output`, async () => {
      const h = setup(provider)
      expect(await h.run('--yes')).toBe(EXIT_OK)
      const text = h.out()
      const expectedCalls = provider === 'grok' ? 3 : 4
      expect(h.transport.requests).toHaveLength(expectedCalls)
      expect(text).toContain(`call 1 of 4: text + schema with an optional field: ok`)
      expect(text).toMatch(/adapter usage: input \d+, output \d+, cache read \d+, cache write \d+/)
      expect(text).toMatch(/raw usage: \{/)
      const declared = providerDescriptor(provider).liveChecks
      for (const check of declared) expect(text, check.id).toContain(check.id)
      expect(text).toMatch(/summary: \d+ PASS, \d+ FAIL, \d+ UNKNOWN/)
      expect(text).toMatch(/spent \$[\d.]+ of \$0\.25/)
      expect(text + h.err()).not.toContain(KEYS[provider])
      expect(h.transport.requests.every((request) => JSON.stringify(request.headers).includes(KEYS[provider]))).toBe(true)
    })
  }

  it('shows the planner-style restore: the optional field null of a strict reply is not left in the data', async () => {
    const h = setup('openai')
    await h.run('--yes')
    expect(h.out()).toContain('data: {"word":"rill","count":3}')
  })

  it('passes the measurable checks of Grok from the fixture usage and refuses the PDF with no request', async () => {
    const h = setup('grok')
    await h.run('--yes')
    const text = h.out()
    expect(text).toMatch(/PASS\s+usage-output-total/)
    expect(text).toMatch(/PASS\s+usage-cached-subset/)
    expect(text).toMatch(/PASS\s+cache-write-unreported/)
    expect(text).toMatch(/PASS\s+served-model-id/)
    expect(text).toMatch(/UNKNOWN\s+effort-xhigh/)
    expect(text).toMatch(/call 4 of 4: PDF: refused before any request/)
  })

  it('passes the usage checks of Gemini and Meta from their fixture usage', async () => {
    const gemini = setup('gemini')
    await gemini.run('--yes')
    expect(gemini.out()).toMatch(/PASS\s+usage-thoughts-separate/)
    expect(gemini.out()).toMatch(/PASS\s+usage-input-includes-cached/)
    const meta = setup('meta')
    await meta.run('--yes')
    expect(meta.out()).toMatch(/PASS\s+completion-tokens-include-reasoning/)
  })

  it('refuses without the key of the provider, before any request', async () => {
    const h = setup('openai', [], { ANTHROPIC_API_KEY: KEYS.anthropic })
    expect(await h.run('--yes')).toBe(EXIT_ERROR)
    expect(h.err()).toContain('OPENAI_API_KEY is not set')
    expect(h.transport.requests).toHaveLength(0)
  })

  it('applies the budget guard before the first call: a budget below the worst case of one call sends nothing', async () => {
    const h = setup('openai')
    expect(await h.run('--yes', '--budget-usd', '0.0001')).toBe(EXIT_ERROR)
    expect(h.err()).toMatch(/below the worst case of the first call/)
    expect(h.transport.requests).toHaveLength(0)
  })

  it('stops when the next call no longer fits and marks the rest as not run', async () => {
    const dry = setup('openai', ['--dry'])
    await dry.run()
    const worstFirst = Number(/call 1 of 4:.*worst case \$([\d.]+)/u.exec(dry.out())?.[1])
    const h = setup('openai')
    const budget = (worstFirst * 1.5).toFixed(6)
    expect(await h.run('--yes', '--budget-usd', budget)).toBe(EXIT_OK)
    expect(h.transport.requests.length).toBeLessThan(4)
    expect(h.out()).toMatch(/not run: the budget/)
    expect(h.out()).toMatch(/UNKNOWN\s+pdf-schema-reasoning/)
  })

  it('reports an API failure as FAIL measurements and exits with an error code only for a rejected key', async () => {
    const h = setup('openai')
    h.transport.script({ kind: 'json', status: 401, body: { error: { message: `Incorrect API key provided: ${KEYS.openai}.`, type: 'invalid_request_error', code: 'invalid_api_key' } } })
    expect(await h.run('--yes')).toBe(EXIT_ERROR)
    expect(h.out() + h.err()).not.toContain(KEYS.openai)
    expect(h.err()).toMatch(/rejected the key/)
    expect(h.transport.requests).toHaveLength(1)
  })

  it('writes nothing to disk', async () => {
    const h = setup('openai')
    await h.run('--yes')
    expect(existsSync(join(dir, 'results'))).toBe(false)
  })

  it('exits with a usage error for bad arguments', async () => {
    const out: string[] = []
    const err: string[] = []
    const io: CliIo = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), env: {}, now: () => 0 }
    expect(await main(['check-provider', '--provider', 'mistral', '--model', 'x'], io)).toBe(EXIT_USAGE)
    expect(err.join('')).toContain('usage: pnpm eval check-provider')
  })
})
