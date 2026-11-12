import { describe, expect, it } from 'vitest'
import {
  AnthropicProvider,
  DEFAULT_DESCRIPTORS,
  LlmError,
  MODEL_TABLE,
  PROVIDER_IDS,
  anthropicExchange,
  capabilitiesOf,
  createProvider,
  createRegistry,
  findModel,
  listModels,
  modelCapabilities,
  parseModelSpec,
  priceFor,
  type LlmProvider,
  type ProviderDescriptor,
  type ProviderFactoryOptions,
} from '../src/index'

function fakeDescriptor(id: 'openai' | 'meta', seen: ProviderFactoryOptions[]): ProviderDescriptor {
  const base = DEFAULT_DESCRIPTORS.find((entry) => entry.id === id) as ProviderDescriptor
  return {
    ...base,
    create: (options) => {
      seen.push(options)
      return { name: id, generate: async () => Promise.reject(new Error('unused')) }
    },
  }
}

describe('parseModelSpec', () => {
  it('reads provider:model and treats a bare id as Anthropic', () => {
    expect(parseModelSpec('openai:gpt-6.1-sol')).toEqual({ provider: 'openai', model: 'gpt-6.1-sol' })
    expect(parseModelSpec('claude-opus-5-5')).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(parseModelSpec('anthropic:claude-haiku-5-5')).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' })
    expect(parseModelSpec('  meta:muse-spark-1.3 ')).toEqual({ provider: 'meta', model: 'muse-spark-1.3' })
  })

  it('names the known providers when the provider is unknown, and rejects an empty spec or model', () => {
    for (const bad of ['mistral:large', 'OPENAI:gpt-6-luna']) {
      const act = () => parseModelSpec(bad)
      expect(act).toThrow(LlmError)
      expect(act).toThrow(/known providers: anthropic, openai, gemini, grok, meta/)
    }
    expect(() => parseModelSpec('')).toThrow(/empty/)
    expect(() => parseModelSpec('   ')).toThrow(/empty/)
    expect(() => parseModelSpec('openai:')).toThrow(/openai:<model id>/)
  })
})

describe('createRegistry', () => {
  const env = { OPENAI_API_KEY: 'sk-from-env', META_API_KEY: 'meta-from-env', XAI_API_KEY: '  ' }

  it('builds the provider with the model, the key from the descriptor variable and the injected pieces', () => {
    const seen: ProviderFactoryOptions[] = []
    const registry = createRegistry([fakeDescriptor('openai', seen)])
    const fetch = (async () => new Response('{}')) as typeof globalThis.fetch
    const sleep = async () => undefined
    const random = () => 0.1
    const client = { marker: true }
    const provider = registry.createProvider('openai:gpt-6.1-sol', { env, fetch, sleep, random, client, baseURL: 'http://x.test', maxRetries: 0 })
    expect(provider.name).toBe('openai')
    expect(seen).toEqual([{ model: 'gpt-6.1-sol', apiKey: 'sk-from-env', fetch, sleep, random, client, baseURL: 'http://x.test', maxRetries: 0 }])
  })

  it('names the missing variable, and never the value of another one', () => {
    const registry = createRegistry(DEFAULT_DESCRIPTORS)
    for (const [spec, variable] of [
      ['openai:gpt-6-luna', 'OPENAI_API_KEY'],
      ['gemini:gemini-4-carbon', 'GEMINI_API_KEY'],
      ['grok:grok-4.7', 'XAI_API_KEY'],
      ['meta:muse-spark-1.3', 'META_API_KEY'],
      ['claude-opus-5-5', 'ANTHROPIC_API_KEY'],
    ] as const) {
      const act = () => registry.createProvider(spec, { env: { OTHER: 'secret-value' } })
      expect(act).toThrow(variable)
      expect(act).not.toThrow(/secret-value/)
      try {
        act()
      } catch (error) {
        expect((error as LlmError).kind).toBe('auth')
      }
    }
    expect(() => registry.createProvider('grok:grok-4.7', { env })).toThrow('XAI_API_KEY')
  })

  it('rejects an unknown model for a vendor and lists the known ones', () => {
    const registry = createRegistry(DEFAULT_DESCRIPTORS)
    const act = () => registry.createProvider('openai:gpt-9', { env })
    expect(act).toThrow(/unknown model 'gpt-9'/)
    expect(act).toThrow(/gpt-6\.1-sol/)
    expect(() => registry.createProvider('mistral:x', { env })).toThrow(/unknown provider/)
  })

  it.each(['meta:muse-spark-1.3-contributor', 'meta:muse-spark-1.2-contributor', 'meta:MUSE-SPARK-1.3-CONTRIBUTOR', 'claude-opus-5-5-contributor'])('refuses the contributor id %s before asking for a key', (spec) => {
    const registry = createRegistry(DEFAULT_DESCRIPTORS)
    const act = () => registry.createProvider(spec, { env: {} })
    expect(act).toThrow(/contributor/)
    expect(act).not.toThrow(/API key/)
    expect(registry.findModel(spec)).toBeUndefined()
  })

  it('lets Anthropic take any bare id and passes the model through', () => {
    const provider = createProvider('claude-opus-5-5-20260301', { env: { ANTHROPIC_API_KEY: 'k' } })
    expect(provider).toBeInstanceOf(AnthropicProvider)
    expect((provider as AnthropicProvider).model).toBe('claude-opus-5-5-20260301')
  })

  it('puts an injected fetch into the Anthropic client with SDK retries off', async () => {
    const calls: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }), { status: 529, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    const provider = createProvider('claude-haiku-5-5', { env: { ANTHROPIC_API_KEY: 'k' }, fetch, baseURL: 'http://anthropic.test' })
    await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema: { type: 'object' } })).rejects.toMatchObject({ kind: 'overloaded' })
    expect(calls).toEqual(['http://anthropic.test/v1/messages'])
  })

  it('creates the OpenAI provider now that its adapter has landed', () => {
    expect(createProvider('openai:gpt-6-luna', { env })).toMatchObject({ name: 'openai' })
  })
})

describe('model lookups', () => {
  it('finds a model by spec and returns undefined for anything unknown or malformed', () => {
    expect(findModel('openai:gpt-6.1-sol')).toMatchObject({ provider: 'openai', id: 'gpt-6.1-sol', tier: 'mid' })
    expect(findModel('claude-opus-5-5')).toMatchObject({ provider: 'anthropic', tier: 'strong' })
    expect(findModel('openai:nope')).toBeUndefined()
    expect(findModel('nope:gpt-6.1-sol')).toBeUndefined()
    expect(findModel('openai:')).toBeUndefined()
    expect(findModel('')).toBeUndefined()
  })

  it('lists every model once, Anthropic first, in a stable order', () => {
    const models = listModels()
    expect(models).toEqual([...MODEL_TABLE])
    expect(models.map((model) => model.provider).filter((provider, index, all) => all.indexOf(provider) === index)).toEqual([...PROVIDER_IDS])
    expect(new Set(models.map((model) => `${model.provider}:${model.id}`)).size).toBe(models.length)
    expect(listModels()).not.toBe(models)
  })
})

describe('the model table', () => {
  it('has a price for every model, in the dated table', () => {
    for (const model of MODEL_TABLE) expect(priceFor(model.id), model.id).toBeDefined()
  })

  it('keeps each descriptor consistent with its own models and key variable', () => {
    expect(DEFAULT_DESCRIPTORS.map((entry) => [entry.id, entry.keyEnv])).toEqual([
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
      ['gemini', 'GEMINI_API_KEY'],
      ['grok', 'XAI_API_KEY'],
      ['meta', 'META_API_KEY'],
    ])
    for (const entry of DEFAULT_DESCRIPTORS) {
      expect(entry.models.length, entry.id).toBeGreaterThan(0)
      for (const model of entry.models) expect(model.provider).toBe(entry.id)
    }
  })

  it('never lists a contributor model', () => {
    expect(MODEL_TABLE.filter((model) => model.id.endsWith('-contributor'))).toEqual([])
  })

  it('keeps each model capability record coherent', () => {
    for (const { id, capabilities: caps, contextTokens } of MODEL_TABLE) {
      expect(contextTokens, id).toBeGreaterThan(0)
      expect(caps.dataNote.length, id).toBeGreaterThan(20)
      expect(Object.keys(caps.effortMap).sort(), id).toEqual(['high', 'low', 'max', 'medium', 'xhigh'])
      const distinct = new Set(caps.effortLevels.map((level) => caps.effortMap[level]))
      expect(distinct.size, id).toBe(caps.effortLevels.length)
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(distinct.has(caps.effortMap[level]), `${id} ${level}`).toBe(true)
      if (caps.cache === 'explicit') expect(caps.maxCacheBreakpoints, id).toBeGreaterThan(0)
      else expect(caps.maxCacheBreakpoints, id).toBeUndefined()
      if (caps.maxOutputTokens !== undefined) expect(caps.maxOutputTokens, id).toBeLessThanOrEqual(contextTokens)
    }
  })

  it('states the documented differences between the vendors', () => {
    const caps = (spec: string) => findModel(spec)?.capabilities
    expect(caps('grok:grok-4.7')).toMatchObject({ documents: 'none', images: ['image/png', 'image/jpeg'], reasoningCappedByMaxTokens: false, cache: 'automatic' })
    expect(caps('grok:grok-4.7')?.effortMap.max).toBe('xhigh')
    expect(caps('grok:grok-4.5')?.effortMap).toMatchObject({ xhigh: 'high', max: 'high' })
    expect(caps('grok:grok-4.5')?.effortLevels).toEqual(['low', 'medium', 'high'])
    expect(caps('gemini:gemini-4-carbon')).toMatchObject({ cache: 'automatic', streaming: 'required', effortLevels: ['low', 'medium', 'high'] })
    expect(caps('gemini:gemini-4-carbon')?.images).not.toContain('image/gif')
    expect(caps('gemini:gemini-4-carbon')?.dataNote).toMatch(/free/i)
    expect(caps('gemini:gemini-4-carbon')?.dataNote).toMatch(/training/i)
    expect(caps('openai:gpt-6.1-sol')).toMatchObject({ cache: 'explicit', maxCacheBreakpoints: 3, maxRequestBytes: 50_000_000, structuredOutput: 'strict' })
    expect(caps('meta:muse-spark-1.3')?.effortMap.max).toBe('max')
    expect(caps('meta:muse-spark-1.2')?.effortMap.max).toBe('xhigh')
    expect(caps('meta:muse-spark-1.1')?.effortLevels).not.toContain('max')
    expect(caps('meta:muse-ember-1.0')?.maxOutputTokens).toBe(524_288)
    expect(caps('meta:muse-wonder-1.0')?.dataNote).toMatch(/preview/i)
    expect(caps('meta:muse-wonder-1.0')?.dataNote).toMatch(/Korea/)
    expect(findModel('grok:grok-4.3')?.contextTokens).toBe(1_000_000)
  })
})

describe('capabilitiesOf', () => {
  const bare: LlmProvider = { name: 'fake', generate: async () => Promise.reject(new Error('unused')) }

  it('falls back to the Anthropic defaults for a provider that declares none', () => {
    const caps = capabilitiesOf(bare)
    expect(caps).toMatchObject({ documents: 'native-pdf', cache: 'explicit', maxCacheBreakpoints: 4, structuredOutput: 'strict' })
    expect(caps.images).toHaveLength(4)
    expect(caps.effortMap.max).toBe('max')
    expect(capabilitiesOf(bare)).toBe(caps)
  })

  it('returns what a provider declares', () => {
    const declared = findModel('grok:grok-4.7')?.capabilities
    expect(declared).toBeDefined()
    expect(capabilitiesOf({ ...bare, capabilities: declared })).toBe(declared)
  })

  it('is what AnthropicProvider declares, so the default and the real provider agree', () => {
    expect(capabilitiesOf(new AnthropicProvider({ apiKey: 'k' }))).toBe(capabilitiesOf(bare))
  })
})

describe('anthropicExchange', () => {
  const okBody = {
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'abc' }, { type: 'fallback' }, { type: 'text', text: 'x' }],
    usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: null },
  }

  it('reads a good reply', () => {
    expect(anthropicExchange.parse(JSON.stringify(okBody), true)).toEqual({
      model: 'claude-opus-5-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 },
      contentBlockTypes: ['thinking', 'fallback', 'text'],
      fallbackBlocks: 1,
      thinkingChars: 3,
      badReply: null,
    })
  })

  it('flags a successful reply that cannot be used', () => {
    expect(anthropicExchange.parse('', true).badReply).toBe('the reply body is empty')
    expect(anthropicExchange.parse('<html>', true).badReply).toBe('the reply is not JSON')
    expect(anthropicExchange.parse('[]', true).badReply).toBe('the reply is not a JSON object')
    expect(anthropicExchange.parse('{"usage":{}}', true).badReply).toBe('the reply has no content array')
    expect(anthropicExchange.parse('{"content":[]}', true).badReply).toBe('the reply has no usage')
    expect(anthropicExchange.parse(JSON.stringify({ content: [], usage: { input_tokens: -1, output_tokens: 1 } }), true).badReply).toBe('the reply has an invalid usage.input_tokens')
    expect(anthropicExchange.parse(JSON.stringify({ content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 'x' } }), true).badReply).toBe('the reply has an invalid usage.cache_read_input_tokens')
  })

  it('does not flag an error reply and still reads what it can', () => {
    expect(anthropicExchange.parse('<html>', false).badReply).toBeNull()
    expect(anthropicExchange.parse('{"type":"error"}', false)).toMatchObject({ model: null, badReply: null })
    expect(anthropicExchange.parse(JSON.stringify({ model: 'm', usage: { input_tokens: 5, output_tokens: 'bad' } }), false).usage).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })
})

describe('modelCapabilities', () => {
  it('returns the capabilities of a model in a list and fails loudly for an unknown id', () => {
    const models = findModel('grok:grok-4.5') === undefined ? [] : [findModel('grok:grok-4.5')!]
    expect(modelCapabilities(models, 'grok-4.5').effortMap.max).toBe('high')
    expect(() => modelCapabilities(models, 'grok-9')).toThrow('grok-9')
  })
})
