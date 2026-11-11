import type { LlmPart } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_RULES,
  AttachmentError,
  MAX_ATTACHMENTS_PER_CONVERSATION,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PLANNER_RULES,
  PlanError,
  createPlanner,
  encodeGeneration,
  generationSchema,
  normalizeQuestions,
  questionTurnsSinceLastWorkflow,
  systemBlocks,
  type AttachmentStore,
  type PlanResultBody,
  type PlanTurn,
} from '../src/index'
import { FakeProvider } from './fake-provider'
import { ROOT, fakeAttachments, question, questionsData, receipts, ref, registry, request, slackWorkflow, workflowBody, workflowData } from './fixtures'

const store: AttachmentStore = { read: async () => new Uint8Array([1]) }

async function planError(promise: Promise<unknown>): Promise<PlanError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlanError) return error
    throw error
  }
  throw new Error('expected a PlanError')
}

const asked: PlanResultBody = { kind: 'questions', summary: 'q', questions: [question('folder', ['Inbox', 'Desktop'])] }

function questionTurns(count: number): PlanTurn[] {
  return Array.from({ length: count }, (_, i) => [
    { role: 'user' as const, text: `u${i}` },
    { role: 'assistant' as const, text: 'q', result: asked },
  ]).flat()
}

describe('questions and unsupported', () => {
  it('returns questions as the answer of a turn', async () => {
    const provider = new FakeProvider([{ data: questionsData([question('folder', ['Inbox', 'Desktop'], 'Desktop')]) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'watch a folder' }))
    expect(result).toMatchObject({ kind: 'questions', questions: [{ id: 'folder', options: ['Inbox', 'Desktop'], default: 'Desktop' }], summary: 'I need to know' })
    expect(result.rounds).toHaveLength(1)
  })

  it('returns unsupported with the nearest supported thing', async () => {
    const data = encodeGeneration({ kind: 'unsupported', summary: 'No email', reason: 'rill cannot send email', nearest: 'a Slack message' })
    const result = await createPlanner({ provider: new FakeProvider([{ data }]), registry }).plan(request({ text: 'email me' }))
    expect(result).toMatchObject({ kind: 'unsupported', reason: 'rill cannot send email', nearest: 'a Slack message', summary: 'No email' })
  })

  it('keeps at most 3 questions and records the truncation without a repair round', async () => {
    const provider = new FakeProvider([{ data: questionsData(['a', 'b', 'c', 'd', 'e'].map((id) => question(id))) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.kind === 'questions' && result.questions.map((q) => q.id)).toEqual(['a', 'b', 'c'])
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0]!.issues).toEqual([expect.objectContaining({ stage: 4, code: 'questions_truncated', pointer: '/questions/3' })])
  })

  it('bounds options to 2 to 4 and makes the default one of them', () => {
    const many = normalizeQuestions([question('q', ['1', '2', '3', '4', '5', '6'], '6')])
    expect(many.questions).toEqual([{ id: 'q', text: 'question q?', options: ['1', '2', '3', '4'], default: '1' }])
    expect(many.issues.map((i) => i.code)).toEqual(['question_options_truncated', 'question_default_replaced'])
    const kept = normalizeQuestions([question('q', ['a', 'b', 'c'], 'c')])
    expect(kept.questions[0]!.default).toBe('c')
    expect(kept.issues).toEqual([])
    expect(normalizeQuestions([question('q', ['a', 'b', 'c', 'd'])]).issues).toEqual([])
    expect(normalizeQuestions([question('q', ['a', 'a', ' '])]).issues.map((i) => i.code)).toEqual(['question_options'])
    expect(normalizeQuestions([question('q', ['a', 'b']), question('q', ['c', 'd'])]).issues.map((i) => i.code)).toEqual(['question_duplicate_id'])
    expect(normalizeQuestions([]).issues.map((i) => i.code)).toEqual(['questions_empty'])
    expect(normalizeQuestions([1, 2, 3].map((n) => question(`q${n}`))).issues).toEqual([])
  })

  it('repairs a question with too few options', async () => {
    const provider = new FakeProvider([{ data: questionsData([question('q', ['only'])]) }, { data: questionsData([question('q', ['a', 'b'])]) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[0]!.issues.map((i) => i.code)).toEqual(['question_options'])
  })
})

describe('question turn limit', () => {
  it('counts question turns since the last workflow turn', () => {
    expect(questionTurnsSinceLastWorkflow([])).toBe(0)
    expect(questionTurnsSinceLastWorkflow(questionTurns(2))).toBe(2)
    const reset: PlanTurn[] = [...questionTurns(2), { role: 'user', text: 'x' }, { role: 'assistant', text: 'w', result: workflowBody(receipts()) }, ...questionTurns(1)]
    expect(questionTurnsSinceLastWorkflow(reset)).toBe(1)
    expect(questionTurnsSinceLastWorkflow([{ role: 'assistant', text: 'plain' }, ...questionTurns(1)])).toBe(1)
  })

  it('allows questions after one question turn', async () => {
    const provider = new FakeProvider([{ data: questionsData([question('x')]) }])
    const result = await createPlanner({ provider, registry }).plan(request({ turns: questionTurns(1) }))
    expect(result.kind).toBe('questions')
    expect(provider.calls[0]!.request.schema).toEqual(generationSchema(registry))
  })

  it('removes questions from the schema after two question turns and tells the model to plan', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts(), 'Used the default folder') }])
    const result = await createPlanner({ provider, registry }).plan(request({ turns: questionTurns(2) }))
    expect(result.kind).toBe('workflow')
    const sent = provider.calls[0]!.request
    expect(sent.schema).toEqual(generationSchema(registry, { allowQuestions: false }))
    expect(sent.messages.at(-1)!.content as string).toContain('Do not ask again')
  })

  it('treats questions after the limit as a failed round', async () => {
    const provider = new FakeProvider([{ data: questionsData([question('x')]) }, { data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request({ turns: questionTurns(2) }))
    expect(result.kind).toBe('workflow')
    expect(result.rounds[0]!.issues.map((i) => i.code)).toEqual(['questions_not_allowed'])
  })
})

describe('deterministic gaps', () => {
  it('asks to set up a connection when none is configured instead of repairing', async () => {
    const provider = new FakeProvider([{ data: workflowData(slackWorkflow()) }])
    const result = await createPlanner({ provider, registry }).plan(request({ context: { ...request().context, connections: [] } }))
    expect(provider.calls).toHaveLength(1)
    expect(result.kind).toBe('questions')
    if (result.kind !== 'questions') return
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0]).toMatchObject({ id: 'setup_connection', default: 'Set up a connection first' })
    expect(result.questions[0]!.text).toContain('(needed by n1)')
    expect(result.questions[0]!.text).not.toContain('team')
    expect(result.rounds[0]!.issues.map((i) => i.code)).toEqual(['unknown_connection'])
  })

  it('asks to allow a folder when no folder is allowed', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request({ context: { ...request().context, allowedRoots: [] } }))
    expect(result.kind === 'questions' && result.questions.map((q) => q.id)).toEqual(['allow_folder'])
    expect(result.kind === 'questions' && result.questions[0]!.text).toContain('(needed by n2, t1)')
  })

  it('repairs other errors first and sends no gap to the model', async () => {
    const bad = slackWorkflow()
    bad.nodes.push({ id: 'n2', type: 'delay@1', config: { ms: 1 } })
    bad.edges.push({ from: 'n2', to: 'n1' })
    const provider = new FakeProvider([{ data: workflowData(bad) }, { data: workflowData(slackWorkflow()) }])
    const result = await createPlanner({ provider, registry }).plan(request({ context: { ...request().context, connections: [] } }))
    const sent = JSON.parse(provider.calls[1]!.request.messages[2]!.content as string) as { issues: { code: string }[] }
    expect(sent.issues.map((i) => i.code)).toEqual(['unreachable'])
    expect(result.kind).toBe('questions')
  })

  it('repairs an unknown connection when connections exist and a folder outside roots when roots exist', async () => {
    const slack = slackWorkflow()
    slack.nodes[1]!.config = { connection: 'nope', text: 'x' }
    const provider = new FakeProvider([{ data: workflowData(slack) }, { data: workflowData(slackWorkflow()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.kind).toBe('workflow')
    expect(result.rounds).toHaveLength(2)
  })
})

describe('conversation turns', () => {
  it('maps earlier turns one to one with stored results and answers', async () => {
    const turns: PlanTurn[] = [
      { role: 'user', text: 'Watch a folder' },
      { role: 'assistant', text: 'Which folder?', result: asked },
      { role: 'user', text: '', answers: { folder: 'Desktop' } },
      { role: 'assistant', text: 'plain text only' },
    ]
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry }).plan(request({ turns, text: 'and log it' }))
    const messages = provider.calls[0]!.request.messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(messages[0]!.content).toBe('Watch a folder')
    expect(messages[1]!.content).toBe(JSON.stringify(encodeGeneration(asked)))
    expect(messages[2]!.content).toBe('Answers to your questions:\n- folder: Desktop')
    expect(JSON.stringify(messages.filter((m) => m.role === 'user'))).not.toContain('question folder?')
    expect(messages[3]!.content).toBe('plain text only')
    expect(messages[4]!.content as string).toContain('Request:\nand log it')
  })

  it('renders answers without a matching question and keeps the text first', async () => {
    const turns: PlanTurn[] = [{ role: 'user', text: 'hi', answers: { b: '2', a: '1' } }, { role: 'assistant', text: 'ok' }]
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry }).plan(request({ turns }))
    expect(provider.calls[0]!.request.messages[0]!.content).toBe('hi\n\nAnswers to your questions:\n- a: 1\n- b: 2')
  })

  it('re-sends earlier attachments with one cache breakpoint on the last earlier part', async () => {
    const attachments = fakeAttachments()
    const turns: PlanTurn[] = [
      { role: 'user', text: 'first', attachments: [ref('a1')] },
      { role: 'assistant', text: 'q', result: asked },
      { role: 'user', text: 'second', attachments: [ref('a2'), ref('a3')] },
      { role: 'assistant', text: 'q', result: asked },
    ]
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(request({ turns, attachments: [ref('a4')] }))
    expect(attachments.prepares).toEqual([
      { refs: ['a1'], cacheLast: false },
      { refs: ['a2', 'a3'], cacheLast: true },
      { refs: ['a4'], cacheLast: false },
    ])
    const sent = provider.calls[0]!.request
    const first = sent.messages[0]!.content as LlmPart[]
    expect(first[0]).toEqual({ type: 'text', text: 'first' })
    expect(first[1]).toMatchObject({ type: 'text', text: '<attachment>content of a1</attachment>' })
    const last = sent.messages[4]!.content as LlmPart[]
    expect(last[1]).toMatchObject({ text: '<attachment>content of a4</attachment>' })
    const breakpoints = sent.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((p) => p.cache === true)
    expect(breakpoints).toEqual([{ type: 'text', text: '<attachment>content of a3</attachment>', cache: true }])
    expect(sent.system).toEqual(systemBlocks(registry, ATTACHMENT_RULES))
  })

  it('appends the attachment rules to the rules block only', () => {
    expect(systemBlocks(registry, 'ATTACH')[0]!.text).toBe(`${PLANNER_RULES}\n\nATTACH`)
    expect(systemBlocks(registry, '')[0]!.text).toBe(PLANNER_RULES)
    expect(systemBlocks(registry)[1]!.cache).toBe(true)
  })

  it('enforces the attachment limits before any call', async () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ref(`m${i}`))
    const attachments = fakeAttachments()
    const provider = new FakeProvider([])
    const error = await planError(createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(request({ attachments: many })))
    expect(error.kind).toBe('attachment')
    expect(attachments.prepares).toEqual([])
    const earlier: PlanTurn[] = [
      { role: 'user', text: 'a', attachments: Array.from({ length: 5 }, (_, i) => ref(`e${i}`)) },
      { role: 'assistant', text: 'q' },
      { role: 'user', text: 'b', attachments: Array.from({ length: 4 }, (_, i) => ref(`f${i}`)) },
      { role: 'assistant', text: 'q' },
    ]
    const tooMany = await planError(createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(request({ turns: earlier, attachments: [ref('x'), ref('y')] })))
    expect(tooMany.kind).toBe('attachment')
    expect(tooMany.message).toContain(String(MAX_ATTACHMENTS_PER_CONVERSATION))
    expect(provider.calls).toHaveLength(0)
    const ok = new FakeProvider([{ data: workflowData(receipts()) }, { data: workflowData(receipts()) }])
    await createPlanner({ provider: ok, registry, attachments, attachmentStore: store }).plan(request({ turns: earlier, attachments: [ref('x')] }))
    await createPlanner({ provider: ok, registry, attachments, attachmentStore: store }).plan(request({ attachments: many.slice(0, MAX_ATTACHMENTS_PER_MESSAGE) }))
    expect(ok.calls).toHaveLength(2)
  })

  it('maps an AttachmentError to PlanError attachment', async () => {
    const failure = new AttachmentError('too_large', ref('big'), 'too large')
    const attachments = fakeAttachments({ failWith: failure })
    const provider = new FakeProvider([])
    const error = await planError(createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(request({ attachments: [ref('big')] })))
    expect(error.kind).toBe('attachment')
    expect(error.cause).toBe(failure)
    expect(provider.calls).toHaveLength(0)
  })

  it('rethrows other prepare failures', async () => {
    const attachments = fakeAttachments({ failWith: new TypeError('bug') })
    await expect(createPlanner({ provider: new FakeProvider([]), registry, attachments, attachmentStore: store }).plan(request({ attachments: [ref('a')] }))).rejects.toThrow(TypeError)
  })

  it('needs an attachment store when attachments are given', async () => {
    const error = await planError(createPlanner({ provider: new FakeProvider([]), registry, attachments: fakeAttachments() }).plan(request({ attachments: [ref('a')] })))
    expect(error.kind).toBe('attachment')
  })

  it('uses the default attachment module without attachments', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request({ context: { ...request().context, allowedRoots: [ROOT] } }))
    expect(result.kind).toBe('workflow')
    expect(provider.calls[0]!.request.system).toEqual(systemBlocks(registry))
  })
})
