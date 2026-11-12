import { describe, expect, it } from 'vitest'
import { replyOf as openaiReply } from '../../llm/test/openai-wire'
import { okReply as grokReply } from '../../llm/test/grok/wire'
import { streamReply as geminiReply } from '../../llm/test/gemini/wire'
import { chatReply as metaReply } from '../../llm/test/meta-wire'
import { createFakeTransport, jsonReply, type FakeReply } from '../../llm/test/fake-transport'
import { UsageError } from '../src/cli-shared'
import { createSpecProvider, hostsOf, keyNeeds, missingKeysMessage, resolveModelSpecs } from '../src/providers'

describe('resolveModelSpecs', () => {
  it('accepts bare Claude ids and provider:model specs, in order', () => {
    const infos = resolveModelSpecs('--models', ['claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'gemini:gemini-3.8-flash', 'grok:grok-4.7', 'meta:muse-spark-1.3', 'anthropic:claude-haiku-5-5'])
    expect(infos.map((info) => [info.spec, info.provider, info.model])).toEqual([
      ['claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5'],
      ['openai:gpt-6.1-sol', 'openai', 'gpt-6.1-sol'],
      ['gemini:gemini-3.8-flash', 'gemini', 'gemini-3.8-flash'],
      ['grok:grok-4.7', 'grok', 'grok-4.7'],
      ['meta:muse-spark-1.3', 'meta', 'muse-spark-1.3'],
      ['anthropic:claude-haiku-5-5', 'anthropic', 'claude-haiku-5-5'],
    ])
    expect(infos[1]?.keyEnv).toBe('OPENAI_API_KEY')
    expect(infos[3]?.keyEnv).toBe('XAI_API_KEY')
    expect(infos[4]?.keyEnv).toBe('META_API_KEY')
  })

  it('keeps accepting a Claude id the table does not list', () => {
    expect(resolveModelSpecs('--models', ['claude-fable-9'])[0]?.provider).toBe('anthropic')
  })

  it('refuses an unknown provider and names the known ones', () => {
    expect(() => resolveModelSpecs('--models', ['mistral:large'])).toThrow(UsageError)
    expect(() => resolveModelSpecs('--models', ['mistral:large'])).toThrow(/unknown provider 'mistral'.*anthropic, openai, gemini, grok, meta/)
  })

  it('refuses an unknown model of a provider and lists that provider\'s models', () => {
    expect(() => resolveModelSpecs('--models', ['openai:gpt-9'])).toThrow(/unknown model 'gpt-9' for OpenAI; known models: gpt-6-astra/)
  })

  it('refuses a contributor id of any provider, a bare Claude id included, before looking for the model', () => {
    for (const spec of ['meta:muse-spark-1.3-contributor', 'openai:gpt-6-luna-contributor', 'grok:grok-4.7-contributor', 'claude-sonnet-5-5-contributor']) {
      expect(() => resolveModelSpecs('--models', [spec]), spec).toThrow(/contributor model that trains on your content/)
    }
  })

  it('refuses an id with odd characters and an empty model', () => {
    expect(() => resolveModelSpecs('--models', ['Claude Sonnet'])).toThrow(/--models must list model ids/)
    expect(() => resolveModelSpecs('--models', ['openai:'])).toThrow(UsageError)
  })

  it('refuses the same model listed twice under two spellings', () => {
    expect(() => resolveModelSpecs('--models', ['claude-haiku-5-5', 'anthropic:claude-haiku-5-5'])).toThrow(/twice/)
  })
})

describe('keys', () => {
  const infos = resolveModelSpecs('--models', ['claude-haiku-5-5', 'openai:gpt-6.1-sol', 'openai:gpt-6-luna', 'grok:grok-4.7'])

  it('needs one key per provider, whatever the number of models', () => {
    const needs = keyNeeds(infos, { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x' })
    expect(needs.map((need) => [need.provider, need.keyEnv, need.present, need.specs])).toEqual([
      ['anthropic', 'ANTHROPIC_API_KEY', true, ['claude-haiku-5-5']],
      ['openai', 'OPENAI_API_KEY', true, ['openai:gpt-6.1-sol', 'openai:gpt-6-luna']],
      ['grok', 'XAI_API_KEY', true, ['grok:grok-4.7']],
    ])
    expect(missingKeysMessage(needs)).toBeUndefined()
  })

  it('names every missing variable at once, so nothing is spent before a key is missing', () => {
    const needs = keyNeeds(infos, { OPENAI_API_KEY: '  ', ANTHROPIC_API_KEY: 'a' })
    const message = missingKeysMessage(needs)!
    expect(message).toContain('OPENAI_API_KEY')
    expect(message).toContain('XAI_API_KEY')
    expect(message).not.toContain('ANTHROPIC_API_KEY')
    expect(message).toContain('openai:gpt-6.1-sol')
    expect(message).toContain('grok:grok-4.7')
    expect(message).toMatch(/every provider/)
  })

  it('lists the API host each provider sends your content to', () => {
    expect(hostsOf(infos)).toEqual({ anthropic: 'api.anthropic.com', openai: 'api.openai.com', grok: 'api.x.ai' })
    expect(hostsOf(resolveModelSpecs('--models', ['gemini:gemini-3.8-flash', 'meta:muse-spark-1.3']))).toEqual({ gemini: 'generativelanguage.googleapis.com', meta: 'api.meta.ai' })
  })
})

const ANTHROPIC_REPLY: FakeReply = jsonReply({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: '{"a":1}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 30 },
})

const CASES: { spec: string; reply: FakeReply; key: string; maxField: (body: Record<string, unknown>) => unknown }[] = [
  { spec: 'claude-sonnet-5-5', reply: ANTHROPIC_REPLY, key: 'sk-ant-test-key-1', maxField: (body) => body['max_tokens'] },
  { spec: 'openai:gpt-6.1-sol', reply: openaiReply(false, 'completed', '{"a":1}'), key: 'sk-openai-test-key-2', maxField: (body) => body['max_output_tokens'] },
  { spec: 'gemini:gemini-3.8-flash', reply: geminiReply('{"a":1}'), key: 'gemini-test-key-3', maxField: (body) => (body['generation_config'] as Record<string, unknown>)['max_output_tokens'] },
  { spec: 'grok:grok-4.7', reply: grokReply(), key: 'xai-test-key-4', maxField: (body) => body['max_output_tokens'] },
  { spec: 'meta:muse-spark-1.3', reply: metaReply('{"a":1}'), key: 'meta-test-key-5', maxField: (body) => body['max_completion_tokens'] },
]

describe('createSpecProvider', () => {
  const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false }

  for (const { spec, reply, key, maxField } of CASES) {
    it(`drives ${spec} through the recorder, with the max tokens of the run and the key kept out of the record`, async () => {
      const transport = createFakeTransport()
      transport.script(reply)
      const { provider, recorder } = createSpecProvider({ model: spec, apiKey: key, maxTokens: 4321, timeoutMs: 30_000, fetch: transport.fetch, effort: 'low' })
      const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema })
      expect(result.data).toEqual({ a: 1 })
      const exchanges = recorder.exchanges()
      expect(exchanges).toHaveLength(1)
      expect(exchanges[0]?.status).toBe(200)
      expect(exchanges[0]?.badReply).toBeNull()
      expect(exchanges[0]?.requestMaxTokens).toBe(4321)
      expect(maxField(transport.requests[0]!.json as Record<string, unknown>)).toBe(4321)
      expect(JSON.stringify(exchanges)).not.toContain(key)
      expect(transport.requests).toHaveLength(1)
    })
  }

  it('applies the effort override to every request and keeps what the provider declares', async () => {
    const transport = createFakeTransport()
    transport.script(openaiReply(false, 'completed', '{"a":1}'))
    const { provider } = createSpecProvider({ model: 'openai:gpt-6.1-sol', apiKey: 'sk-openai-test-key-2', fetch: transport.fetch, effort: 'low' })
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema, effort: 'high' })
    expect((transport.requests[0]!.json as { reasoning: { effort: string } }).reasoning.effort).toBe('low')
    expect(provider.capabilities?.cache).toBe('explicit')
  })

  it('asks every provider for the run default of 16000 output tokens when the caller names none', async () => {
    for (const { spec, reply, key, maxField } of CASES) {
      const transport = createFakeTransport()
      transport.script(reply)
      const { provider } = createSpecProvider({ model: spec, apiKey: key, fetch: transport.fetch })
      await provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema })
      expect(maxField(transport.requests[0]!.json as Record<string, unknown>), spec).toBe(16_000)
    }
  })

  it('hands the run signal to every non-Anthropic provider, so an abort stops the call before any request', async () => {
    for (const { spec, reply, key } of CASES.filter((entry) => !entry.spec.startsWith('claude'))) {
      const transport = createFakeTransport()
      transport.script(reply)
      const controller = new AbortController()
      controller.abort()
      const { provider } = createSpecProvider({ model: spec, apiKey: key, fetch: transport.fetch, signal: controller.signal })
      await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema }), spec).rejects.toMatchObject({ kind: 'aborted' })
      expect(transport.requests, spec).toHaveLength(0)
    }
  })

  it('declares the model capabilities on the provider it hands out', () => {
    const transport = createFakeTransport()
    const { provider } = createSpecProvider({ model: 'grok:grok-4.7', apiKey: 'xai-test-key-4', fetch: transport.fetch })
    expect(provider.capabilities?.documents).toBe('none')
    expect(provider.name).toBe('grok')
  })

  it('refuses an empty key and an unknown model before building anything', () => {
    expect(() => createSpecProvider({ model: 'openai:gpt-6.1-sol', apiKey: ' ' })).toThrow(/non-empty apiKey/)
    expect(() => createSpecProvider({ model: 'openai:gpt-9', apiKey: 'k' })).toThrow(/unknown model/)
  })
})
