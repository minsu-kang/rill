import { LlmError, type LlmProvider, type LlmRequest } from '@rill/llm'
import { createCoreRegistry, llmExtract } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { IGNORED_SCHEMA_KEYWORDS, buildRequest } from '../../llm/src/gemini/request'
import { geminiDescriptor } from '../../llm/src/gemini'
import { makeCtx } from '../../nodes-core/test/helpers'
import { convertSchema } from '../src/convert'
import { generationSchema } from '../src/generation'

type Json = Record<string, unknown>

const caps = geminiDescriptor.models[2]!.capabilities
const GEMINI = geminiDescriptor.models[2]!.id

const SCHEMA_CHILDREN = ['items', 'additionalProperties', 'not', 'if', 'then', 'else']
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions']

function keywordPaths(node: unknown, path = '#'): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return []
  const record = node as Json
  const found = Object.keys(record)
    .filter((key) => (IGNORED_SCHEMA_KEYWORDS as readonly string[]).includes(key))
    .map((key) => `${path}/${key}`)
  for (const key of SCHEMA_CHILDREN) found.push(...keywordPaths(record[key], `${path}/${key}`))
  for (const key of SCHEMA_LISTS) {
    const list = record[key]
    if (Array.isArray(list)) list.forEach((child, index) => found.push(...keywordPaths(child, `${path}/${key}/${index}`)))
  }
  for (const key of SCHEMA_MAPS) {
    const map = record[key]
    if (typeof map === 'object' && map !== null) for (const [name, child] of Object.entries(map)) found.push(...keywordPaths(child, `${path}/${key}/${name}`))
  }
  return found
}

function sentSchema(schema: Json): Json {
  const params = buildRequest(GEMINI, caps, { schema, messages: [{ role: 'user', content: 'x' }] }, 32_768)
  return (params.response_format as { schema: Json }).schema
}

async function extractionSchema(): Promise<Json> {
  const seen: LlmRequest[] = []
  const llm: LlmProvider = {
    name: 'fake',
    generate: async (request) => {
      seen.push(request)
      return {
        data: { amount: 1, date: '2026-11-11', vendor: 'x' },
        model: 'fake',
        requestedModel: 'fake',
        stopReason: 'end',
        durationMs: 1,
        fallbackUsed: false,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }
    },
  }
  const fields = [{ name: 'amount', type: 'number', description: 'total paid' }, { name: 'date', type: 'date' }, { name: 'vendor', type: 'string' }]
  await llmExtract.execute({ text: 'Paid 1 at x on 2026-11-11', fields }, makeCtx({ llm }))
  return seen[0]!.schema
}

describe('Gemini request schema on the schemas rill really sends', () => {
  const registry = createCoreRegistry()

  it.each([
    ['create', { mode: 'create', allowQuestions: true }],
    ['create without questions', { mode: 'create', allowQuestions: false }],
    ['patch', { mode: 'patch', allowQuestions: true }],
  ] as const)('the planner %s schema passes through unchanged, with every key in its place', (_name, options) => {
    const schema = generationSchema(registry, options) as Json
    const sent = sentSchema(schema)
    expect(sent).toEqual(schema)
    expect(JSON.stringify(sent)).toBe(JSON.stringify(schema))
  })

  it('the extraction schema passes through unchanged', async () => {
    const schema = await extractionSchema()
    expect(schema).toMatchObject({ type: 'object', required: ['amount', 'date', 'vendor'] })
    expect(sentSchema(schema)).toEqual(schema)
  })

  it('the converted planner schema (what planner prompts use) passes through unchanged', () => {
    const converted = convertSchema(generationSchema(registry)).schema
    expect(sentSchema(converted)).toEqual(converted)
  })

  it('loses only ignored keywords on the raw node config schemas, which are full of constraints', () => {
    let withKeywords = 0
    for (const def of registry.list()) {
      const raw = JSON.parse(JSON.stringify(def.configSchema)) as Json
      const before = keywordPaths(raw)
      const sent = sentSchema(raw)
      expect(keywordPaths(sent), def.type).toEqual([])
      expect(Object.keys((sent.properties ?? {}) as Json), def.type).toEqual(Object.keys((raw.properties ?? {}) as Json))
      expect(sent.required, def.type).toEqual(raw.required)
      if (before.length === 0) {
        expect(sent, def.type).toEqual(raw)
        continue
      }
      withKeywords += 1
      expect(JSON.stringify(sent).length, def.type).toBeLessThan(JSON.stringify(raw).length)
    }
    expect(withKeywords).toBeGreaterThanOrEqual(5)
  })

  it('refuses a node schema whose reference points nowhere, as an invalid request', () => {
    const broken: Json = { type: 'object', properties: { a: { $ref: '#/$defs/gone' } } }
    expect(() => sentSchema(broken)).toThrow(LlmError)
  })
})
