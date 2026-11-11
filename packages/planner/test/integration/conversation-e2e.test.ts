import type { Workflow } from '@rill/dsl'
import type { LlmPart, LlmRequest } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import {
  EFFORT_BUDGETS,
  createPlanner,
  encodeGeneration,
  encodePatchOp,
  generationSchema,
  type PatchOp,
  type PlanEffort,
  type PlanRequest,
  type PlanResult,
  type PlanTurn,
  type Planner,
} from '../../src/index'
import { FakeProvider } from '../fake-provider'
import { ROOT, question, questionsData, receipts, registry, request, workflowData } from '../fixtures'
import { attachmentRef, breakpoints, countingStore } from './helpers'

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('receipt bytes')])

function patchData(ops: PatchOp[], summary = 'Changed'): unknown {
  return { kind: 'workflow', summary, patch: ops.map(encodePatchOp) }
}

function existing(): Workflow {
  const workflow = receipts()
  workflow.nodes[0]!.config = { folder: `${ROOT}/Receipts`, glob: '*.pdf', pollMs: 2500, stableMs: 1500 }
  workflow.nodes.push({ id: 'n3', type: 'http.request@1', config: { url: 'https://api.example.com/x', method: 'POST' } })
  workflow.edges.push({ from: 'n2', to: 'n3' })
  return workflow
}

function patchRequest(nodeId: string, extra: Partial<PlanRequest> = {}): PlanRequest {
  return request({ text: 'change this node', selection: { nodeId }, context: { ...request().context, existingWorkflow: existing() }, ...extra })
}

function allCalls(provider: FakeProvider): { request: LlmRequest; timeoutMs: number | undefined }[] {
  return provider.calls.map((call) => ({ request: call.request, timeoutMs: call.options?.timeoutMs }))
}

async function converse(planner: Planner, provider: FakeProvider, steps: { text: string; answers?: Record<string, string> }[]): Promise<{ results: PlanResult[]; turns: PlanTurn[] }> {
  const results: PlanResult[] = []
  let turns: PlanTurn[] = []
  for (const [index, step] of steps.entries()) {
    const result = await planner.plan(request({ text: step.text, turns }))
    results.push(result)
    turns = [...turns, { role: 'user', text: step.text, ...(step.answers === undefined ? {} : { answers: step.answers }) }, { role: 'assistant', text: result.summary, result }]
    expect(provider.calls).toHaveLength(index + 1)
  }
  return { results, turns }
}

describe('conversation end to end', () => {
  describe('questions, answers and the question-turn limit', () => {
    it('asks, receives the answers as part of the next user turn and plans', async () => {
      const ask = questionsData([question('folder', ['Receipts', 'Documents'], 'Receipts')], 'Which folder?')
      const provider = new FakeProvider([{ data: ask }, { data: workflowData(receipts(), 'Watching Receipts') }])
      const planner = createPlanner({ provider, registry })
      const first = await planner.plan(request({ text: 'Put my receipts into a ledger' }))
      expect(first).toMatchObject({ kind: 'questions', questions: [{ id: 'folder', default: 'Receipts' }] })

      const turns: PlanTurn[] = [
        { role: 'user', text: 'Put my receipts into a ledger' },
        { role: 'assistant', text: first.summary, result: first },
        { role: 'user', text: 'the first one', answers: { folder: 'Receipts' } },
      ]
      const second = await planner.plan(request({ text: 'ok, go ahead', turns }))
      expect(second.kind).toBe('workflow')
      const sent = provider.calls[1]!.request
      expect(sent.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'user'])
      expect(sent.messages[1]!.content).toBe(JSON.stringify(encodeGeneration(first)))
      expect(sent.messages[2]!.content).toBe('the first one\n\nAnswers to your questions:\n- folder: Receipts')
      expect((sent.messages[3]!.content as string).endsWith('Request:\nok, go ahead')).toBe(true)
      expect(sent.schema).toEqual(generationSchema(registry))
    })

    it('removes the questions kind from the schema after two question turns and plans with defaults on the third', async () => {
      const ask = (id: string) => ({ data: questionsData([question(id, ['a', 'b'])]) })
      const provider = new FakeProvider([ask('one'), ask('two'), { data: workflowData(receipts(), 'Used the default folder') }])
      const { results } = await converse(createPlanner({ provider, registry }), provider, [
        { text: 'watch a folder' },
        { text: 'the first one', answers: { one: 'a' } },
        { text: 'still unsure', answers: { two: 'b' } },
      ])
      expect(results.map((result) => result.kind)).toEqual(['questions', 'questions', 'workflow'])
      const [one, two, three] = allCalls(provider).map((call) => call.request)
      const kinds = (schema: LlmRequest['schema']): string[] => ((schema.properties as { kind: { enum: string[] } }).kind.enum)
      expect(kinds(one!.schema)).toEqual(['workflow', 'questions', 'unsupported'])
      expect(kinds(two!.schema)).toEqual(['workflow', 'questions', 'unsupported'])
      expect(kinds(three!.schema)).toEqual(['workflow', 'unsupported'])
      expect(Object.keys(three!.schema.properties as object)).not.toContain('questions')
      expect(three!.schema).toEqual(generationSchema(registry, { allowQuestions: false }))
      expect(three!.messages.at(-1)!.content as string).toContain('You already asked questions 2 times in a row')
      expect(two!.messages.at(-1)!.content as string).not.toContain('You already asked')
    })

    it('resets the count after a workflow and allows questions again', async () => {
      const ask = (id: string) => ({ data: questionsData([question(id)]) })
      const provider = new FakeProvider([ask('one'), { data: workflowData(receipts()) }, ask('two')])
      const planner = createPlanner({ provider, registry })
      const { turns } = await converse(planner, provider, [{ text: 'a' }, { text: 'b', answers: { one: 'a' } }])
      const third = await planner.plan(request({ text: 'now something else', turns }))
      expect(third.kind).toBe('questions')
      expect(allCalls(provider)[2]!.request.schema).toEqual(generationSchema(registry))
    })

    it('treats a question the model asks after the limit as a failed round and repairs it', async () => {
      const turns: PlanTurn[] = []
      for (let i = 0; i < 2; i++) {
        turns.push({ role: 'user', text: `u${i}` }, { role: 'assistant', text: 'q', result: { kind: 'questions', summary: 'q', questions: [question('x')] } })
      }
      const provider = new FakeProvider([{ data: questionsData([question('x')]) }, { data: workflowData(receipts()) }])
      const result = await createPlanner({ provider, registry }).plan(request({ turns }))
      expect(result.kind).toBe('workflow')
      expect(result.rounds[0]!.issues.map((issue) => issue.code)).toEqual(['questions_not_allowed'])
      expect(provider.calls[1]!.request.schema).toEqual(generationSchema(registry, { allowQuestions: false }))
    })
  })

  describe('patch mode', () => {
    it('keeps the hidden advanced fields of the selected folderWatch after a set_config', async () => {
      const ops: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/Receipts`, glob: '*.png' } }]
      const provider = new FakeProvider([{ data: patchData(ops, 'Watch PNG files') }])
      const result = await createPlanner({ provider, registry }).plan(patchRequest('t1'))
      if (result.kind !== 'workflow') throw new Error('expected a workflow')
      expect(result.workflow.nodes[0]!.config).toEqual({ folder: `${ROOT}/Receipts`, glob: '*.png', pollMs: 2500, stableMs: 1500 })
      expect(result.patch).toEqual(ops)
      expect(result.summary).toBe('Watch PNG files')
      expect(result.workflow.nodes.slice(1)).toEqual(existing().nodes.slice(1))
      const sent = provider.calls[0]!.request
      expect(sent.schema).toEqual(generationSchema(registry, { mode: 'patch' }))
      expect(Object.keys(sent.schema.properties as object)).toContain('patch')
      expect(Object.keys(sent.schema.properties as object)).not.toContain('workflow')
      expect(sent.messages.at(-1)!.content as string).toContain('for the selected node t1')
    })

    it('makes the model repair a patch that sets a hidden field and still keeps the stored values', async () => {
      const bad: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/Receipts`, glob: '*.png', pollMs: 200 } }]
      const good: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/Receipts`, glob: '*.png' } }]
      const provider = new FakeProvider([{ data: patchData(bad) }, { data: patchData(good) }])
      const result = await createPlanner({ provider, registry }).plan(patchRequest('t1'))
      expect(result.rounds[0]!.issues.map((issue) => issue.code)).toEqual(['planner_hidden_field'])
      if (result.kind !== 'workflow') throw new Error('expected a workflow')
      expect(result.workflow.nodes[0]!.config).toMatchObject({ pollMs: 2500, stableMs: 1500 })
    })

    it('flags a new egress node added by a patch', async () => {
      const ops: PatchOp[] = [
        { op: 'add_node', node: { id: 'n4', type: 'http.request@1', config: { url: 'https://hooks.example.net/in', method: 'POST' } } },
        { op: 'connect', edge: { from: 'n2', to: 'n4' } },
      ]
      const provider = new FakeProvider([{ data: patchData(ops) }])
      const result = await createPlanner({ provider, registry }).plan(patchRequest('n3'))
      if (result.kind !== 'workflow') throw new Error('expected a workflow')
      expect(result.flags.map((flag) => [flag.nodeId, flag.code])).toEqual([['n4', 'new_egress_target']])
      expect(result.needsConfirmation).toBe(true)
      expect(result.summary).toContain('Also changed')
    })

    it('does not flag an egress target that already sits in the existing workflow', async () => {
      const ops: PatchOp[] = [{ op: 'set_config', nodeId: 'n3', config: { url: 'https://api.example.com/x', method: 'PUT' } }]
      const provider = new FakeProvider([{ data: patchData(ops) }])
      const result = await createPlanner({ provider, registry }).plan(patchRequest('n3'))
      if (result.kind !== 'workflow') throw new Error('expected a workflow')
      expect(result.flags.filter((flag) => flag.nodeId === 'n3')).toEqual([])
    })

    it.fails('lets set_config change the retry policy of an existing node, as the patch schema offers', async () => {
      const wire = { op: 'set_config', nodeId: 'n3', config: JSON.stringify({ url: 'https://api.example.com/x', method: 'POST' }), retry: { maxAttempts: 3 } }
      const provider = new FakeProvider([{ data: { kind: 'workflow', summary: 'retry', patch: [wire] } }])
      const result = await createPlanner({ provider, registry }).plan(patchRequest('n3'))
      if (result.kind !== 'workflow') throw new Error('expected a workflow')
      expect(result.workflow.nodes.find((node) => node.id === 'n3')?.retry).toEqual({ maxAttempts: 3 })
    })
  })

  describe('effort, token budget and timeout reach every call of a chain', () => {
    const efforts: PlanEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

    function chain(): FakeProvider {
      const full = receipts()
      full.nodes[2]!.config = { file: `${ROOT}/ledger.csv`, row: ['{{n1.output.nope}}'] }
      full.nodes.push({ id: 'n3', type: 'delay@1', config: { ms: 'soon' } })
      full.edges.push({ from: 'n2', to: 'n3' })
      const configOnly = receipts()
      configOnly.nodes.push({ id: 'n3', type: 'delay@1', config: { ms: 'later' } })
      configOnly.edges.push({ from: 'n2', to: 'n3' })
      return new FakeProvider([{ data: workflowData(full) }, { data: workflowData(configOnly) }, { data: { ms: 5 } }])
    }

    it.each(efforts)('sends effort %s, the table budget and at least the table timeout on a full, a config-only and a targeted call', async (effort) => {
      const provider = chain()
      const result = await createPlanner({ provider, registry }).plan(request({ effort }))
      expect(result.rounds.map((round) => round.targeted)).toEqual([[], [], ['n3']])
      const calls = allCalls(provider)
      expect(calls).toHaveLength(3)
      for (const { request: sent, timeoutMs } of calls) {
        expect(sent.effort).toBe(effort)
        expect(sent.maxTokens).toBe(EFFORT_BUDGETS[effort].maxTokens)
        expect(timeoutMs).toBeGreaterThanOrEqual(EFFORT_BUDGETS[effort].timeoutMs)
        if (effort === 'low' || effort === 'medium' || effort === 'high') expect(sent.maxTokens).toBeLessThanOrEqual(16_000)
        expect(breakpoints(sent)).toBeLessThanOrEqual(4)
      }
    })

    it('keeps the budget table monotonic in effort', () => {
      const order: PlanEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
      for (let i = 1; i < order.length; i++) {
        expect(EFFORT_BUDGETS[order[i]!].maxTokens).toBeGreaterThanOrEqual(EFFORT_BUDGETS[order[i - 1]!].maxTokens)
        expect(EFFORT_BUDGETS[order[i]!].timeoutMs).toBeGreaterThan(EFFORT_BUDGETS[order[i - 1]!].timeoutMs)
      }
    })
  })

  describe('attachments in turn history', () => {
    it('re-reads earlier attachments from the store on every turn and keeps the result free of bytes', async () => {
      const store = countingStore({ pdf: PDF })
      const provider = new FakeProvider([{ data: workflowData(receipts(), 'first') }, { data: workflowData(receipts(), 'second') }])
      const planner = createPlanner({ provider, registry, attachmentStore: store })
      const ref = attachmentRef('pdf', 'application/pdf')
      const first = await planner.plan(request({ text: 'use this receipt', attachments: [ref] }))
      expect(store.reads).toEqual(['pdf'])
      expect(JSON.stringify(first)).not.toContain(PDF.toString('base64'))

      const turns: PlanTurn[] = [{ role: 'user', text: 'use this receipt', attachments: [ref] }, { role: 'assistant', text: first.summary, result: first }]
      expect(JSON.stringify(turns)).not.toContain(PDF.toString('base64'))
      await planner.plan(request({ text: 'and watch Receipts', turns }))
      expect(store.reads).toEqual(['pdf', 'pdf'])
      const sent = provider.calls[1]!.request
      const documents = sent.messages.flatMap((message) => (typeof message.content === 'string' ? [] : message.content)).filter((part: LlmPart) => part.type === 'document')
      expect(documents).toEqual([{ type: 'document', mediaType: 'application/pdf', data: PDF.toString('base64'), cache: true }])
      expect(sent.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
      expect(JSON.stringify(sent.messages[1])).not.toContain(PDF.toString('base64'))
    })

    it('fails with an attachment error, before any call, when an earlier turn names an attachment that is gone from the store', async () => {
      const store = countingStore({})
      const provider = new FakeProvider([{ data: workflowData(receipts()) }])
      const turns: PlanTurn[] = [{ role: 'user', text: 'old', attachments: [attachmentRef('gone', 'application/pdf')] }, { role: 'assistant', text: 'ok', result: { kind: 'unsupported', summary: 's', reason: 'r', nearest: 'n' } }]
      await expect(createPlanner({ provider, registry, attachmentStore: store }).plan(request({ turns }))).rejects.toMatchObject({ kind: 'attachment' })
      expect(provider.calls).toHaveLength(0)
    })
  })
})
