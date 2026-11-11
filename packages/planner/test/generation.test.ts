import { describe, expect, it } from 'vitest'
import { decodeGeneration, encodeGeneration, generationCodec, generationSchema, type PlanResultBody } from '../src/index'
import { ROOT, receipts, registry, request, slackWorkflow, workflowBody, workflowData } from './fixtures'

type Json = Record<string, unknown>

const FORBIDDEN = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'oneOf', 'anyOf', 'allOf', '$ref', 'patternProperties', 'format']

function objects(schema: Json, path = '#'): { path: string; schema: Json }[] {
  const found: { path: string; schema: Json }[] = []
  if (schema.type === 'object') found.push({ path, schema })
  for (const [name, child] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) found.push(...objects(child, `${path}/${name}`))
  if (schema.items !== undefined) found.push(...objects(schema.items as Json, `${path}[]`))
  return found
}

function keywords(schema: unknown): string[] {
  if (schema === null || typeof schema !== 'object') return []
  if (Array.isArray(schema)) return schema.flatMap(keywords)
  return Object.entries(schema as Json).flatMap(([key, value]) => (key === 'properties' ? Object.values(value as Json).flatMap(keywords) : [key, ...keywords(value)]))
}

const ctx = () => ({ registry, context: request().context })

describe('generationSchema', () => {
  for (const options of [{}, { mode: 'patch' as const }, { allowQuestions: false }, { mode: 'patch' as const, allowQuestions: false }]) {
    it(`stays in the structured-output subset (${JSON.stringify(options)})`, () => {
      const schema = generationSchema(registry, options)
      for (const { path, schema: object } of objects(schema)) {
        expect(object.additionalProperties, path).toBe(false)
        const names = Object.keys(object.properties as Json)
        const required = object.required as string[]
        expect(required.every((name) => names.includes(name)), path).toBe(true)
        expect(names.length - required.length, path).toBeLessThanOrEqual(8)
      }
      for (const keyword of FORBIDDEN) expect(keywords(schema)).not.toContain(keyword)
      expect(JSON.stringify(schema)).not.toContain('"type":[')
    })
  }

  it('lists the node types of the registry as an enum', () => {
    const schema = generationSchema(registry) as Json
    const node = (((schema.properties as Json).workflow as Json).properties as Json).nodes as Json
    const type = ((node.items as Json).properties as Json).type as Json
    expect(type.enum).toEqual(registry.list().map((def) => def.type).sort())
    expect(((node.items as Json).properties as Json).config).toMatchObject({ type: 'string' })
  })

  it('uses a patch member instead of a workflow in patch mode', () => {
    const create = (generationSchema(registry) as Json).properties as Json
    const patch = (generationSchema(registry, { mode: 'patch' }) as Json).properties as Json
    expect(Object.keys(create)).toEqual(['kind', 'summary', 'workflow', 'questions', 'unsupported'])
    expect(Object.keys(patch)).toEqual(['kind', 'summary', 'patch', 'questions', 'unsupported'])
    const op = ((patch.patch as Json).items as Json).properties as Json
    expect((op.op as Json).enum).toEqual(['add_node', 'set_config', 'remove_node', 'connect', 'disconnect'])
    expect(op.config).toMatchObject({ type: 'string' })
  })

  it('drops questions from the kind enum when questions are not allowed', () => {
    const schema = generationSchema(registry, { allowQuestions: false }) as Json
    const properties = schema.properties as Json
    expect((properties.kind as Json).enum).toEqual(['workflow', 'unsupported'])
    expect(properties.questions).toBeUndefined()
  })

  it('returns a fresh copy each time', () => {
    const first = generationSchema(registry) as Json
    first.properties = {}
    expect(Object.keys((generationSchema(registry) as Json).properties as Json)).toContain('workflow')
    expect(generationCodec.schema(registry)).toEqual(generationSchema(registry))
  })
})

describe('encodeGeneration and decodeGeneration', () => {
  it('round-trips a workflow', () => {
    const workflow = receipts()
    workflow.nodes[1]!.retry = { maxAttempts: 3, baseDelayMs: 200 }
    workflow.nodes[1]!.onError = 'continue'
    const decoded = decodeGeneration(encodeGeneration(workflowBody(workflow)), ctx())
    expect(decoded.issues).toEqual([])
    expect(decoded.body).toEqual(workflowBody(workflow))
    expect(encodeGeneration(decoded.body!)).toEqual(encodeGeneration(workflowBody(workflow)))
  })

  it('encodes configs as JSON text and drops the schema version', () => {
    const encoded = encodeGeneration(workflowBody(receipts())) as unknown as Json
    const nodes = (encoded.workflow as Json).nodes as Json[]
    expect(typeof nodes[0]!.config).toBe('string')
    expect(JSON.parse(nodes[0]!.config as string)).toEqual(receipts().nodes[0]!.config)
    expect(encoded.workflow).not.toHaveProperty('schemaVersion')
    expect(generationCodec.encode(workflowBody(receipts()))).toEqual(encoded)
  })

  it('round-trips questions and unsupported', () => {
    const bodies: PlanResultBody[] = [
      { kind: 'questions', summary: 'q', questions: [{ id: 'folder', text: 'Which folder?', options: ['A', 'B'], default: 'B' }] },
      { kind: 'unsupported', summary: 's', reason: 'no email node', nearest: 'Slack message' },
    ]
    for (const body of bodies) {
      const decoded = decodeGeneration(encodeGeneration(body), ctx())
      expect(decoded.issues).toEqual([])
      expect(decoded.body).toEqual(body)
    }
  })

  it('marks external nodes as needing confirmation', () => {
    const decoded = decodeGeneration(workflowData(slackWorkflow()), ctx())
    expect(decoded.body).toMatchObject({ kind: 'workflow', needsConfirmation: true })
    expect(decodeGeneration(workflowData(receipts()), ctx()).body).toMatchObject({ needsConfirmation: false })
  })

  it('reports a config that is not JSON at /nodes/i/config', () => {
    const data = workflowData(receipts()) as { workflow: { nodes: { config: string }[] } }
    data.workflow.nodes[1]!.config = '{"file": '
    data.workflow.nodes[2]!.config = '[1]'
    const decoded = decodeGeneration(data, ctx())
    expect(decoded.body).toBeUndefined()
    expect(decoded.issues.map((i) => [i.stage, i.pointer, i.code])).toEqual([
      [1, '/nodes/1/config', 'config_json_parse'],
      [1, '/nodes/2/config', 'config_json_parse'],
    ])
  })

  it('reports an envelope that does not match the schema', () => {
    const decoded = decodeGeneration({ kind: 'plan', summary: 1 }, ctx())
    expect(decoded.issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/kind', 'shape_enum'],
      ['/summary', 'shape_type'],
    ])
  })

  it('reports a missing member for the kind', () => {
    for (const kind of ['workflow', 'questions', 'unsupported']) {
      const decoded = decodeGeneration({ kind, summary: 's' }, ctx())
      expect(decoded.issues.map((i) => [i.pointer, i.code])).toEqual([[`/${kind}`, 'missing_member']])
    }
    expect(decodeGeneration({ kind: 'workflow', summary: 's' }, { ...ctx(), mode: 'patch' }).issues[0]!.pointer).toBe('/patch')
  })

  it('runs the shared validator with the request environment', () => {
    const workflow = receipts()
    workflow.nodes[2]!.config = { file: '/elsewhere/ledger.csv', row: ['{{n1.output.total}}'] }
    const codes = decodeGeneration(workflowData(workflow), ctx()).issues.map((i) => [i.pointer, i.code])
    expect(codes).toEqual([
      ['/nodes/2/config/file', 'path_outside_roots'],
      ['/nodes/2/config/row/0', 'unknown_output_field'],
    ])
    const slack = slackWorkflow()
    slack.nodes[1]!.config = { connection: 'other', text: 'x' }
    expect(decodeGeneration(workflowData(slack), ctx()).issues.map((i) => i.code)).toEqual(['unknown_connection'])
  })

  it('reports hidden advanced fields set by the model', () => {
    const workflow = receipts()
    workflow.nodes[0]!.config = { folder: `${ROOT}/Receipts`, pollMs: 500, stableMs: 100 }
    const issues = decodeGeneration(workflowData(workflow), ctx()).issues
    expect(issues.map((i) => [i.stage, i.pointer, i.code])).toEqual([
      [3, '/nodes/0/config/pollMs', 'planner_hidden_field'],
      [3, '/nodes/0/config/stableMs', 'planner_hidden_field'],
    ])
    expect(issues[0]!.message).toContain('node t1')
  })

  it('reports questions when questions are not allowed', () => {
    const data = encodeGeneration({ kind: 'questions', summary: 's', questions: [{ id: 'a', text: 't', options: ['x', 'y'], default: 'x' }] })
    const decoded = decodeGeneration(data, { ...ctx(), allowQuestions: false })
    expect(decoded.body).toBeUndefined()
    expect(decoded.issues.map((i) => [i.stage, i.code])).toEqual([[4, 'questions_not_allowed']])
  })
})
