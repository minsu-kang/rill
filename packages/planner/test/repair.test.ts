import { SCHEMA_VERSION, type Workflow } from '@rill/dsl'
import { LlmError, type LlmPart } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { PlanError, convertSchema, createPlanner, targetNodes, withoutHiddenFields, type Flag, type PlanTurn } from '../src/index'
import { FakeProvider } from './fake-provider'
import { ROOT, fakeAttachments, receipts, registry, request, workflowData } from './fixtures'

async function planError(promise: Promise<unknown>): Promise<PlanError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlanError) return error
    throw error
  }
  throw new Error('expected a PlanError')
}

function outsideRoots(): Workflow {
  const workflow = receipts()
  workflow.nodes[2]!.config = { file: '/elsewhere/ledger.csv', row: ['{{n1.output.date}}'] }
  return workflow
}

function withDelay(ms: unknown, extra: Workflow['nodes'] = []): Workflow {
  const workflow = receipts()
  workflow.nodes.push({ id: 'n3', type: 'delay@1', config: { ms } }, ...extra)
  workflow.edges.push({ from: 'n2', to: 'n3' }, ...extra.map((node) => ({ from: 'n3', to: node.id })))
  return workflow
}

function repairPayload(text: string): { round: number; issues: { code: string; pointer: string; message: string }[] } {
  return JSON.parse(text) as { round: number; issues: { code: string; pointer: string; message: string }[] }
}

describe('repair loop', () => {
  it('feeds the issues and the previous output back and succeeds in round 2', async () => {
    const provider = new FakeProvider([{ data: workflowData(outsideRoots()) }, { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.kind).toBe('workflow')
    expect(result.rounds.map((r) => r.index)).toEqual([0, 1])
    expect(result.rounds[0]!.issues.map((i) => i.code)).toEqual(['path_outside_roots'])
    expect(result.rounds[1]!.issues).toEqual([])
    const second = provider.calls[1]!.request
    expect(second.messages).toHaveLength(3)
    expect(second.messages[0]).toEqual(provider.calls[0]!.request.messages[0])
    expect(second.messages[1]).toEqual({ role: 'assistant', content: JSON.stringify(workflowData(outsideRoots())) })
    expect(second.messages[2]!.role).toBe('user')
    const payload = repairPayload(second.messages[2]!.content as string)
    expect(payload.round).toBe(1)
    expect(payload.issues).toEqual([expect.objectContaining({ stage: 3, pointer: '/nodes/2/config/file', code: 'path_outside_roots' })])
    expect(second.schema).toEqual(provider.calls[0]!.request.schema)
  })

  it('numbers the repair rounds', async () => {
    const provider = new FakeProvider([{ data: workflowData(outsideRoots()) }, { data: workflowData(outsideRoots()) }, { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.rounds).toHaveLength(3)
    const last = provider.calls[2]!.request.messages
    expect(last).toHaveLength(5)
    expect(repairPayload(last[2]!.content as string).round).toBe(1)
    expect(repairPayload(last[4]!.content as string).round).toBe(2)
  })

  it('gives up after three repair rounds with invalid_after_repair', async () => {
    const provider = new FakeProvider(Array.from({ length: 5 }, () => ({ data: workflowData(outsideRoots()) })))
    const error = await planError(createPlanner({ provider, registry }).plan(request()))
    expect(error.kind).toBe('invalid_after_repair')
    expect(error.rounds).toHaveLength(4)
    expect(error.lastIssues.map((i) => i.code)).toEqual(['path_outside_roots'])
    expect(provider.calls).toHaveLength(4)
    expect(provider.remaining).toBe(1)
  })

  it('succeeds on the last allowed repair round', async () => {
    const provider = new FakeProvider([...Array.from({ length: 3 }, () => ({ data: workflowData(outsideRoots()) })), { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.rounds).toHaveLength(4)
  })

  for (const maxRepairRounds of [0, 1, 2]) {
    it(`honours maxRepairRounds ${maxRepairRounds}`, async () => {
      const provider = new FakeProvider(Array.from({ length: 5 }, () => ({ data: workflowData(outsideRoots()) })))
      const error = await planError(createPlanner({ provider, registry, maxRepairRounds }).plan(request()))
      expect(error.kind).toBe('invalid_after_repair')
      expect(provider.calls).toHaveLength(maxRepairRounds + 1)
      expect(error.rounds).toHaveLength(maxRepairRounds + 1)
    })
  }

  it('counts invalid output as a failed round and asks again without inventing an assistant turn', async () => {
    const provider = new FakeProvider([{ error: new LlmError('invalid_output', 'not JSON') }, { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[0]!.issues).toEqual([expect.objectContaining({ stage: 1, code: 'invalid_output', pointer: '' })])
    expect(result.rounds[0]!.usage.inputTokens).toBe(0)
    const messages = provider.calls[1]!.request.messages
    expect(messages).toHaveLength(1)
    const parts = messages[0]!.content as LlmPart[]
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'text', text: provider.calls[0]!.request.messages[0]!.content })
    expect(repairPayload((parts[1] as { text: string }).text).issues[0]!.code).toBe('invalid_output')
  })

  it('fails with invalid_after_repair when every answer is unreadable', async () => {
    const provider = new FakeProvider(Array.from({ length: 4 }, () => ({ error: new LlmError('invalid_output', 'bad') })))
    const error = await planError(createPlanner({ provider, registry }).plan(request()))
    expect(error.kind).toBe('invalid_after_repair')
    expect(error.lastIssues.map((i) => i.code)).toEqual(['invalid_output'])
  })

  it('never repairs because of warnings', async () => {
    const workflow = withDelay('{{n1.output.amount}}')
    const provider = new FakeProvider([{ data: workflowData(workflow) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.kind).toBe('workflow')
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0]!.issues.map((i) => i.code).sort()).toEqual(['nullable_into_required', 'number_into_integer'])
  })

  it('sends only errors and at most 20 of them, sorted', async () => {
    const workflow = receipts()
    workflow.nodes[2]!.config = { file: `${ROOT}/ledger.csv`, row: Array.from({ length: 25 }, (_, i) => `{{n1.output.f${i}}}`) }
    workflow.nodes.push({ id: 'n3', type: 'delay@1', config: { ms: '{{n1.output.amount}}' } })
    workflow.edges.push({ from: 'n2', to: 'n3' })
    const provider = new FakeProvider([{ data: workflowData(workflow) }, { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    const payload = repairPayload(provider.calls[1]!.request.messages[2]!.content as string)
    expect(payload.issues).toHaveLength(20)
    expect(payload.issues.every((i) => i.code === 'unknown_output_field')).toBe(true)
    expect(payload.issues.map((i) => i.pointer)).toEqual(Array.from({ length: 20 }, (_, i) => `/nodes/2/config/row/${i}`))
    expect(result.rounds[0]!.issues).toHaveLength(20)
  })

  it('passes the issues through redactIssues before they reach the model', async () => {
    const flags: Flag[] = [{ nodeId: 'n2', pointer: '/nodes/2/config/file', code: 'new_egress_target', message: 'new' }]
    const attachments = fakeAttachments({ flags })
    const provider = new FakeProvider([{ data: workflowData(outsideRoots()) }, { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry, attachments }).plan(request())
    const payload = repairPayload(provider.calls[1]!.request.messages[2]!.content as string)
    expect(payload.issues).toEqual([{ stage: 3, pointer: '/nodes/2/config/file', code: 'path_outside_roots', message: 'redacted' }])
    expect(JSON.stringify(provider.calls[1]!.request.messages[2])).not.toContain('/elsewhere')
    expect(result.rounds[0]!.issues[0]!.message).toBe('redacted')
    expect(attachments.redactCalls.length).toBeGreaterThan(0)
  })

  it('runs a targeted repair for config issues of one node with the converted node schema', async () => {
    const fixed = withDelay(1000)
    const provider = new FakeProvider([{ data: workflowData(withDelay('soon')) }, { data: { ms: 1000 } }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.kind === 'workflow' && result.workflow).toEqual(fixed)
    expect(result.rounds.map((r) => r.targeted)).toEqual([[], ['n3']])
    const targeted = provider.calls[1]!.request
    expect(targeted.schema).toEqual(convertSchema(withoutHiddenFields(registry.get('delay@1')!)).schema)
    expect(targeted.messages).toHaveLength(1)
    const text = targeted.messages[0]!.content as string
    expect(text).toContain('fix only the config of node n3 (type delay@1)')
    expect(text).toContain('"code":"config_type"')
    expect(text).toContain('Current config of the node (JSON):\n{"ms":"soon"}')
    expect(targeted.system).toEqual(provider.calls[0]!.request.system)
  })

  it('sends the user texts of the whole conversation in a targeted request, but no chosen option', async () => {
    const asked = { id: 'speed', text: 'How long to wait?', options: ['https://options.example.test/wait', 'one second'], default: 'one second' }
    const turns: PlanTurn[] = [
      { role: 'user', text: 'Put my receipts into a ledger and pause between them' },
      { role: 'assistant', text: 'q', result: { kind: 'questions', questions: [asked], summary: 'q' } },
      { role: 'user', text: '', answers: { speed: 'https://options.example.test/wait', note: 'keep it slow' } },
    ]
    const provider = new FakeProvider([{ data: workflowData(withDelay('soon')) }, { data: { ms: 1000 } }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: '', turns }))
    expect(result.rounds.map((r) => r.targeted)).toEqual([[], ['n3']])
    const text = provider.calls[1]!.request.messages[0]!.content as string
    expect(text).toContain('Request:\nPut my receipts into a ledger and pause between them\nkeep it slow\n')
    expect(text).not.toContain('options.example.test')
  })

  it('repairs two nodes with one call each and restores entries and JSON text', async () => {
    const http = { id: 'n4', type: 'http.request@1', config: { url: 'https://api.test/x', method: 'FETCH' } }
    const workflow = withDelay('soon', [http])
    const provider = new FakeProvider([
      { data: workflowData(workflow) },
      { data: { ms: 5 } },
      { data: { url: 'https://api.test/x', method: 'POST', headers: [{ key: 'x-id', value: '{{n1.output.date}}' }], body: '{"amount":"{{n1.output.amount}}"}' } },
    ])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'post to https://api.test/x' }))
    expect(result.rounds.map((r) => r.targeted)).toEqual([[], ['n3', 'n4']])
    expect(provider.calls[2]!.request.schema).toEqual(convertSchema(withoutHiddenFields(registry.get('http.request@1')!)).schema)
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.workflow.nodes[4]!.config).toEqual({
      url: 'https://api.test/x',
      method: 'POST',
      headers: { 'x-id': '{{n1.output.date}}' },
      body: { amount: '{{n1.output.amount}}' },
    })
    expect(result.rounds[1]!.usage.inputTokens).toBe(2000)
  })

  it('does not target three nodes or issues outside the config', async () => {
    const extra = [
      { id: 'n4', type: 'delay@1', config: { ms: 'x' } },
      { id: 'n5', type: 'delay@1', config: { ms: 'y' } },
    ]
    const workflow = withDelay('soon', extra)
    expect(targetNodes([{ stage: 3, pointer: '/nodes/1/config/a', code: 'config_type', message: '' }], workflow)).toEqual([1])
    expect(targetNodes([{ stage: 3, pointer: '/nodes/1/config', code: 'config_rule', message: '' }], workflow)).toEqual([1])
    expect(
      targetNodes(
        [
          { stage: 3, pointer: '/nodes/2/config/a', code: 'config_type', message: '' },
          { stage: 3, pointer: '/nodes/1/config/b', code: 'config_required', message: '' },
        ],
        workflow,
      ),
    ).toEqual([1, 2])
    expect(targetNodes([{ stage: 3, pointer: '/nodes/1/config/a', code: 'unknown_output_field', message: '' }], workflow)).toBeUndefined()
    expect(targetNodes([{ stage: 1, pointer: '/nodes/1/config', code: 'config_json_parse', message: '' }], workflow)).toBeUndefined()
    expect(targetNodes([{ stage: 3, pointer: '/nodes/1/configs', code: 'config_type', message: '' }], workflow)).toBeUndefined()
    expect(targetNodes([], workflow)).toBeUndefined()
    expect(targetNodes([{ stage: 3, pointer: '/nodes/1/config/a', code: 'config_type', message: '' }], undefined)).toBeUndefined()
    const provider = new FakeProvider([{ data: workflowData(workflow) }, { data: workflowData(withDelay(1, [{ ...extra[0]!, config: { ms: 1 } }, { ...extra[1]!, config: { ms: 2 } }])) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.rounds.map((r) => r.targeted)).toEqual([[], []])
    expect(provider.calls[1]!.request.messages).toHaveLength(3)
  })

  it('falls back to a full repair when the targeted answer is still wrong and replays the patched output', async () => {
    const provider = new FakeProvider([{ data: workflowData(withDelay('soon')) }, { data: { ms: 'later' } }, { error: new LlmError('invalid_output', 'x') }, { data: workflowData(withDelay(3)) }])
    const result = await createPlanner({ provider, registry, maxRepairRounds: 3 }).plan(request())
    expect(result.rounds.map((r) => r.targeted)).toEqual([[], ['n3'], ['n3'], []])
    expect(result.rounds[2]!.issues.map((i) => i.code)).toContain('invalid_output')
    const last = provider.calls[3]!.request.messages
    expect(last[1]).toEqual({ role: 'assistant', content: JSON.stringify(workflowData(withDelay('later'))) })
  })

  it('counts a targeted round against the repair cap', async () => {
    const provider = new FakeProvider([{ data: workflowData(withDelay('soon')) }, { data: { ms: 'later' } }])
    const error = await planError(createPlanner({ provider, registry, maxRepairRounds: 1 }).plan(request()))
    expect(error.kind).toBe('invalid_after_repair')
    expect(error.rounds.map((r) => r.targeted)).toEqual([[], ['n3']])
  })

  it('reports a targeted answer that does not restore', async () => {
    const http = { id: 'n3', type: 'http.request@1', config: { url: 'https://a.test', method: 'FETCH' } }
    const workflow: Workflow = { schemaVersion: SCHEMA_VERSION, name: 'x', nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }, http], edges: [{ from: 't1', to: 'n3' }] }
    const provider = new FakeProvider([{ data: workflowData(workflow) }, { data: { url: 'https://a.test', body: '{oops' } }, { data: workflowData({ ...workflow, nodes: [workflow.nodes[0]!, { ...http, config: { url: 'https://a.test' } }] }) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'call https://a.test' }))
    expect(result.rounds[1]!.issues.map((i) => [i.pointer, i.code])).toContainEqual(['/nodes/1/config/body', 'config_json_parse'])
    expect(result.rounds).toHaveLength(3)
  })
})
