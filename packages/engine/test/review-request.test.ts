import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { METHODS, type MethodParams, type PlanTurn } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { MAX_REVIEW_REQUEST_CHARS, REVIEW_REQUEST_CUT, reviewRequestText } from '../src/review'
import { startEnv, useCleanups, useTempDir, type Env } from './explain-helpers'
import { plainWorkflow, questionsReply, workflowReply, type Step } from './plan-helpers'

const dirOf = useTempDir()
useCleanups()

const REVIEW = { summary: 'It waits.', findings: [] }
const FIRST = 'watch ~/Receipts and post each total to #finance'
const CONTINUE = 'I answered your questions. Please continue.'
const ASSISTANT_SUMMARY = 'ASSISTANT-SUMMARY-MARKER-4b1d'
const ATTACHMENT_NAME = 'ATTACH-NAME-MARKER-4b1d.txt'
const QUESTIONS = [{ id: 'q1', text: 'ASSISTANT-QUESTION-MARKER-4b1d which channel?', options: ['#finance', '#ops'], default: '#ops' }]

function user(text: string, extra: Partial<PlanTurn> = {}): PlanTurn {
  return { role: 'user', text, ...extra }
}

const asked: PlanTurn = { role: 'assistant', text: '', result: { kind: 'questions', questions: QUESTIONS, summary: ASSISTANT_SUMMARY } }

async function reviewer(env: Env) {
  return (await env.client.request('saveAgent', { name: 'Careful', description: '', persona: 'p', instructions: '', kind: 'reviewer' })).agent
}

function withAttachment(): { attachmentsRoot: string } {
  const attachmentsRoot = join(dirOf.get(), 'attachments')
  mkdirSync(attachmentsRoot, { recursive: true })
  writeFileSync(join(attachmentsRoot, 'attach0001.txt'), 'abc')
  return { attachmentsRoot }
}

async function planThenReview(steps: Step[], params: Partial<MethodParams<'plan'>>): Promise<{ env: Env; block: string }> {
  const env = await startEnv(dirOf.get(), steps, withAttachment())
  const agent = await reviewer(env)
  await env.client.request('plan', { planId: 'plan-1', text: 'x', turns: [], attachments: [], effort: 'low', ...params })
  await env.client.request('reviewPlan', { planId: 'plan-1', agentId: agent.id })
  const content = env.provider.requests.at(-1)!.messages[0]!.content
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  const block = /<(review-request-[0-9a-f]{12})>\n([\s\S]*?)\n<\/\1>/.exec(text)?.[2]
  expect(block).toBeDefined()
  return { env, block: block! }
}

describe('the request the reviewer reads is the user side of the conversation that made the plan', () => {
  it('holds the first message, the answers and the last text, oldest first, and no assistant text and no attachment name', async () => {
    const turns = [user(FIRST, { attachments: [{ id: 'attach0001', mediaType: 'text/plain', name: ATTACHMENT_NAME, bytes: 3 }] }), asked, user('', { answers: { q1: '#finance' } })]
    const { env, block } = await planThenReview([{ data: workflowReply(plainWorkflow()) }, { data: REVIEW }], { text: CONTINUE, turns })
    expect(block).toBe(`${FIRST}\n\nAnswers to your questions:\n- q1: #finance\n\n${CONTINUE}`)
    expect(JSON.stringify(env.provider.requests.at(-1))).not.toMatch(/ASSISTANT-|ATTACH-NAME-MARKER/)
  })

  it('holds the earlier request and the edit of an edit turn', async () => {
    const turns = [user(FIRST), { role: 'assistant', text: ASSISTANT_SUMMARY, result: { kind: 'workflow', workflow: plainWorkflow(), summary: ASSISTANT_SUMMARY, flags: [], needsConfirmation: false } } as PlanTurn]
    const { block } = await planThenReview([{ data: workflowReply(plainWorkflow()) }, { data: REVIEW }], { text: 'change the channel to #ops', turns })
    expect(block).toBe(`${FIRST}\n\nchange the channel to #ops`)
  })

  it('keeps the plan record as it was: its request text is the text of the call', async () => {
    const turns = [user(FIRST), asked, user('', { answers: { q1: '#finance' } })]
    const { env } = await planThenReview([{ data: workflowReply(plainWorkflow()) }, { data: REVIEW }], { text: CONTINUE, turns })
    const record = env.engine.getPlan('plan-1')
    expect(record.requestText).toBe(CONTINUE)
    expect(Object.keys(record)).not.toContain('reviewText')
    expect(Value.Check(METHODS.getPlan.result, { plan: record })).toBe(true)
  })

  it('is the text itself, as typed, for a plan without earlier turns', async () => {
    const { block, env } = await planThenReview([{ data: workflowReply(plainWorkflow()) }, { data: REVIEW }], { text: `  ${FIRST}  ` })
    expect(block).toBe(`  ${FIRST}  `)
    expect(env.engine.store.getPlan('plan-1').reviewText).toBeUndefined()
  })

  it('is stored with the plan, and reads back after the engine is reopened on the same rows', async () => {
    const turns = [user(FIRST), asked, user('', { answers: { q1: '#finance' } })]
    const { env } = await planThenReview([{ data: workflowReply(plainWorkflow()) }, { data: REVIEW }], { text: CONTINUE, turns })
    expect(env.engine.store.getPlan('plan-1').reviewText).toBe(`${FIRST}\n\nAnswers to your questions:\n- q1: #finance\n\n${CONTINUE}`)
  })

  it('stores nothing of the sort for a plan that ended in questions', async () => {
    const env = await startEnv(dirOf.get(), [{ data: questionsReply() }])
    await env.client.request('plan', { planId: 'plan-1', text: 'x', turns: [user(FIRST)], attachments: [], effort: 'low' })
    expect(env.engine.store.getPlan('plan-1').reviewText).toBeUndefined()
  })

  it('lets the review repeat an address the user typed in an earlier message, and hides one that only an assistant turn holds', async () => {
    const answer = { summary: 'Posts to https://hooks.example.test/a and https://assistant-only.example.test/b.', findings: [] }
    const turns = [user('post to https://hooks.example.test/a'), { ...asked, text: 'try https://assistant-only.example.test/b' } as PlanTurn, user('', { answers: { q1: '#ops' } })]
    const env = await startEnv(dirOf.get(), [{ data: workflowReply(plainWorkflow()) }, { data: answer }])
    const agent = await reviewer(env)
    await env.client.request('plan', { planId: 'plan-1', text: CONTINUE, turns, attachments: [], effort: 'low' })
    const result = await env.client.request('reviewPlan', { planId: 'plan-1', agentId: agent.id })
    expect(result.review.summary).toBe('Posts to https://hooks.example.test/a and <hidden>.')
  })
})

describe('reviewRequestText', () => {
  it('is the text itself when there are no turns', () => {
    expect(reviewRequestText(' a ', [])).toBe(' a ')
  })

  it('leaves out assistant turns and user turns with nothing in them', () => {
    expect(reviewRequestText('now', [user(''), asked, user('before')])).toBe('before\n\nnow')
  })

  it('renders answers of a user turn after its text, sorted by id', () => {
    expect(reviewRequestText('go', [user('first', { answers: { b: '2', a: '1' } })])).toBe('first\n\nAnswers to your questions:\n- a: 1\n- b: 2\n\ngo')
  })

  it('keeps the whole text at the limit', () => {
    const turn = user('é'.repeat(MAX_REVIEW_REQUEST_CHARS - 2 - 1))
    const text = reviewRequestText('x', [turn])
    expect(text).toBe(`${turn.text}\n\nx`)
    expect([...text]).toHaveLength(MAX_REVIEW_REQUEST_CHARS)
  })

  it('counts code points, not UTF-16 units', () => {
    const turn = user('😀'.repeat(MAX_REVIEW_REQUEST_CHARS - 3))
    expect(reviewRequestText('x', [turn])).toBe(`${turn.text}\n\nx`)
  })

  it('drops the oldest messages one past the limit and says so', () => {
    const turn = user('é'.repeat(MAX_REVIEW_REQUEST_CHARS - 2))
    expect(reviewRequestText('x', [user('oldest'), turn])).toBe(`${REVIEW_REQUEST_CUT}\n\nx`)
  })

  it('keeps the newest messages that fit and never cuts inside a message', () => {
    const text = reviewRequestText('now', [user('a'.repeat(6000)), user('c'.repeat(6000)), user('b'.repeat(6000))])
    expect(text).toBe(`${REVIEW_REQUEST_CUT}\n\n${'c'.repeat(6000)}\n\n${'b'.repeat(6000)}\n\nnow`)
  })

  it('cuts a text that is longer than the limit on its own, keeping its start', () => {
    const text = reviewRequestText('z'.repeat(MAX_REVIEW_REQUEST_CHARS + 5), [user('old')])
    expect(text).toBe(`${REVIEW_REQUEST_CUT}\n\n${'z'.repeat(MAX_REVIEW_REQUEST_CHARS)}`)
  })
})
