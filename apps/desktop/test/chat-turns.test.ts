// @vitest-environment node
import type { AttachmentRef, PlanMeta, PlanResultBody } from '@rill/protocol'
import Value from 'typebox/value'
import { PlanTurnSchema } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { workflows } from '../src/fixtures'
import { MAX_TURNS, type ConversationEntry } from '../src/chat/model/conversation'
import { buildTurns } from '../src/chat/model/turns'

const META: PlanMeta = {
  rounds: [],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: 0.01,
  model: 'm',
  effort: 'medium',
  fallbackUsed: false,
}

const ref = (id: string): AttachmentRef => ({ id: `att-${id}-12345678`, mediaType: 'text/plain', name: `${id}.txt`, bytes: 10 })

const questions: PlanResultBody = {
  kind: 'questions',
  summary: 'Which folder?',
  questions: [{ id: 'folder', text: 'Which folder?', options: ['Desktop', 'Documents'], default: 'Desktop' }],
}
const workflow: PlanResultBody = { kind: 'workflow', workflow: workflows.receipt, summary: 'Watches a folder.', flags: [], needsConfirmation: false }

const user = (text: string, extra: Partial<Extract<ConversationEntry, { role: 'user' }>> = {}): ConversationEntry => ({ role: 'user', text, attachments: [], ...extra })
const assistant = (planId: string, result: PlanResultBody): ConversationEntry => ({ role: 'assistant', planId, result, meta: META })

describe('buildTurns', () => {
  it('returns nothing for no entries', () => {
    expect(buildTurns([])).toEqual([])
  })

  it('keeps the order and turns an assistant entry into its summary text with the stored result', () => {
    const turns = buildTurns([user('Watch a folder'), assistant('p1', questions), user('', { answers: { folder: 'Desktop' } }), assistant('p2', workflow)])
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(turns[0]).toEqual({ role: 'user', text: 'Watch a folder' })
    expect(turns[1]).toEqual({ role: 'assistant', text: 'Which folder?', result: questions })
    expect(turns[3]).toEqual({ role: 'assistant', text: 'Watches a folder.', result: workflow })
  })

  it('attaches the answers to the user turn that answered, and the attachments to the user turn that carried them', () => {
    const turns = buildTurns([user('first', { attachments: [ref('a'), ref('b')] }), assistant('p1', questions), user('', { answers: { folder: 'Documents' } })])
    expect(turns[0]).toEqual({ role: 'user', text: 'first', attachments: [ref('a'), ref('b')] })
    expect(turns[2]).toEqual({ role: 'user', text: '', answers: { folder: 'Documents' } })
    expect(turns[1]).not.toHaveProperty('answers')
    expect(turns[1]).not.toHaveProperty('attachments')
  })

  it('leaves out an empty attachment list and an absent answers field', () => {
    const [turn] = buildTurns([user('hi')])
    expect(Object.keys(turn!)).toEqual(['role', 'text'])
  })

  it('does not share arrays or objects with the entries', () => {
    const entries = [user('hi', { attachments: [ref('a')], answers: { x: 'y' } })]
    const [turn] = buildTurns(entries)
    expect(turn!.attachments).not.toBe((entries[0] as { attachments: AttachmentRef[] }).attachments)
    expect(turn!.answers).not.toBe((entries[0] as { answers: Record<string, string> }).answers)
  })

  it('keeps the newest forty turns and starts with a user turn', () => {
    const entries: ConversationEntry[] = []
    for (let i = 0; i < 25; i++) entries.push(user(`u${i}`), assistant(`p${i}`, workflow))
    const turns = buildTurns(entries)
    expect(turns.length).toBeLessThanOrEqual(MAX_TURNS)
    expect(turns[0]!.role).toBe('user')
    expect(turns.at(-1)).toMatchObject({ role: 'assistant' })
    expect(turns.at(-2)).toMatchObject({ role: 'user', text: 'u24' })
  })

  it('caps a text longer than the protocol allows and still gives turns the protocol accepts', () => {
    const long = { ...workflow, summary: 'x'.repeat(9000) } as PlanResultBody
    const turns = buildTurns([user('hi'), assistant('p', long)])
    expect(turns[1]!.text.length).toBeLessThanOrEqual(8000)
    for (const turn of turns) expect(Value.Check(PlanTurnSchema, turn)).toBe(true)
  })

  it('throws nothing for odd input', () => {
    expect(() => buildTurns([assistant('p', workflow)])).not.toThrow()
    expect(buildTurns([assistant('p', workflow)])).toEqual([])
    expect(() => buildTurns([user('a'), user('b')])).not.toThrow()
    expect(buildTurns([user('a'), user('b')])).toHaveLength(2)
  })
})
