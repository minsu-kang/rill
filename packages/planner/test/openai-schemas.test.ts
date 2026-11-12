import { openaiDescriptor, type FetchFn, type LlmProvider } from '@rill/llm'
import { llmExtract, type NodeContext } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { checkEnvelope, createPlanner, generationSchema, type GenerationOptions } from '../src/index'
import { ROOT, receipts, registry, request, workflowData } from './fixtures'

type Json = Record<string, unknown>

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function fillNulls(value: unknown, schema: unknown): unknown {
  if (!isJson(schema)) return value
  if (Array.isArray(schema.anyOf)) {
    const branch = schema.anyOf.find((entry) => !(isJson(entry) && entry.type === 'null'))
    return value === null ? null : fillNulls(value, branch)
  }
  if (Array.isArray(value)) return value.map((entry) => fillNulls(entry, schema.items))
  if (isJson(value) && isJson(schema.properties)) {
    return Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, name in value ? fillNulls(value[name], child) : null]))
  }
  return value
}

function modelFetch(answer: unknown): { fetch: FetchFn; bodies: Json[] } {
  const bodies: Json[] = []
  const fetch: FetchFn = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Json
    bodies.push(body)
    const schema = ((body.text as Json).format as Json).schema
    const text = JSON.stringify(fillNulls(answer, schema))
    const reply = {
      id: 'resp_1',
      object: 'response',
      model: 'gpt-6.1-sol',
      status: 'completed',
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 400, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 3400 },
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, bodies }
}

const openai = (fetch: FetchFn): LlmProvider => openaiDescriptor.create({ model: 'gpt-6.1-sol', apiKey: 'rill-test-key-4f9c2a7e', fetch })

function strictViolations(schema: unknown, path = '#'): string[] {
  if (!isJson(schema)) return []
  const found: string[] = []
  if (schema.type === 'object' || isJson(schema.properties)) {
    const names = Object.keys(isJson(schema.properties) ? schema.properties : {})
    if (schema.additionalProperties !== false) found.push(`${path}: additionalProperties`)
    if (JSON.stringify(schema.required) !== JSON.stringify(names)) found.push(`${path}: required`)
    for (const [name, child] of Object.entries(isJson(schema.properties) ? schema.properties : {})) found.push(...strictViolations(child, `${path}/${name}`))
  }
  if (isJson(schema.items)) found.push(...strictViolations(schema.items, `${path}/items`))
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((entry, index) => found.push(...strictViolations(entry, `${path}/anyOf/${index}`)))
  return found
}

describe('the planner output schema through the OpenAI adapter', () => {
  it.each(['medium', 'high'] as const)('plans a workflow end to end at %s effort: the wire schema is strict and the nulls are removed again', async (effort) => {
    const { fetch, bodies } = modelFetch(workflowData(receipts()))
    const result = await createPlanner({ provider: openai(fetch), registry }).plan(request({ text: `Put my receipts into ${ROOT}/ledger.csv`, effort }))
    expect(result.kind).toBe('workflow')
    if (result.kind !== 'workflow') return
    expect(result.workflow).toEqual(receipts())
    const sent = ((bodies[0]?.text as Json).format as Json).schema
    expect(strictViolations(sent)).toEqual([])
    expect(bodies[0]?.store).toBe(false)
    expect(bodies[0]).not.toHaveProperty('stream')
  })

  it.each<[string, GenerationOptions]>([
    ['create', { mode: 'create' }],
    ['create without questions', { mode: 'create', allowQuestions: false }],
    ['patch', { mode: 'patch' }],
    ['patch without questions', { mode: 'patch', allowQuestions: false }],
  ])('keeps the %s schema valid after the round trip', async (_label, options) => {
    const clean =
      options.mode === 'patch'
        ? {
            kind: 'workflow',
            summary: 'Tidy',
            patch: [
              { op: 'remove_node', nodeId: 'n2' },
              { op: 'set_config', nodeId: 'n1', config: '{"x":1}', retry: { maxAttempts: 2 }, onError: 'continue' },
              { op: 'connect', from: 'a', to: 'b', when: 'yes' },
            ],
          }
        : workflowData(receipts())
    const { fetch, bodies } = modelFetch(clean)
    const provider = openai(fetch)
    const result = await provider.generate({ system: 'x', messages: [{ role: 'user', content: 'go' }], schema: generationSchema(registry, options), maxTokens: 8000 })
    expect(strictViolations(((bodies[0]?.text as Json).format as Json).schema)).toEqual([])
    expect(result.data).toEqual(clean)
    expect(checkEnvelope(result.data, registry, options).issues).toEqual([])
  })
})

describe('the llm.extract schema through the OpenAI adapter', () => {
  const fields = [
    { name: 'amount', type: 'number', description: 'total paid' },
    { name: 'count', type: 'integer' },
    { name: 'paid', type: 'boolean' },
    { name: 'date', type: 'date' },
    { name: 'vendor', type: 'string' },
  ]
  const context = (llm: LlmProvider): NodeContext => ({
    runId: 'r1',
    nodeId: 'n1',
    attempt: 1,
    dryRun: false,
    idempotencyKey: 'r1:n1',
    journal: { get: () => undefined, put: () => undefined },
    sleep: async () => undefined,
    allowedRoots: undefined,
    connections: { get: () => undefined },
    llm,
  })

  it('sends the declared fields as a strict schema unchanged and returns the extracted values', async () => {
    const answer = { amount: 12.5, count: 3, paid: true, date: '2026-11-11', vendor: null }
    const { fetch, bodies } = modelFetch(answer)
    const data = await llmExtract.execute({ text: 'receipt text', fields }, context(openai(fetch)))
    expect(data).toEqual(answer)
    const sent = ((bodies[0]?.text as Json).format as Json).schema as Json
    expect(strictViolations(sent)).toEqual([])
    expect(Object.keys(sent.properties as Json)).toEqual(['amount', 'count', 'paid', 'date', 'vendor'])
    expect((sent.properties as Json).amount).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }], description: 'total paid' })
    expect((sent.properties as Json).date).toEqual({ anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] })
  })
})
