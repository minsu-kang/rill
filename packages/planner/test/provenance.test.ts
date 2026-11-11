import { describe, expect, it } from 'vitest'
import { createPlanner, type AttachmentStore, type Flag, type PlanTurn } from '../src/index'
import { FakeProvider } from './fake-provider'
import { fakeAttachments, question, questionsData, receipts, ref, registry, request, slackWorkflow, workflowData } from './fixtures'

const store: AttachmentStore = { read: async () => new Uint8Array([1]) }
const flag: Flag = { nodeId: 'n2', pointer: '/nodes/2/config/file', code: 'attachment_origin', message: 'from an attachment' }

describe('provenance flags', () => {
  it('calls provenance after a valid workflow with the user texts, answers, existing workflow and attachment texts', async () => {
    const attachments = fakeAttachments({ flags: [flag], texts: { a1: 'invoice text', a2: 'second' } })
    const turns: PlanTurn[] = [
      { role: 'user', text: 'first ask', attachments: [ref('a1')] },
      { role: 'assistant', text: 'q', result: { kind: 'questions', summary: 'q', questions: [question('folder')] } },
      { role: 'user', text: 'answer turn', answers: { folder: 'Desktop' } },
      { role: 'assistant', text: 'q', result: { kind: 'questions', summary: 'q', questions: [question('x')] } },
    ]
    const existing = slackWorkflow()
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(
      request({ turns, text: 'now do it', attachments: [ref('a2')], context: { ...request().context, existingWorkflow: existing } }),
    )
    const input = attachments.provenanceCalls.at(-1)!
    expect(input.workflow).toEqual(receipts())
    expect(input.registry).toBe(registry)
    expect(input.userTexts).toEqual(['first ask', 'answer turn', 'Desktop', 'now do it'])
    expect(input.existingWorkflow).toEqual(existing)
    expect(input.attachmentTexts).toEqual(['invoice text', 'second'])
    expect(result).toMatchObject({ kind: 'workflow', flags: [flag], needsConfirmation: true })
  })

  it('does not turn flags into repair rounds', async () => {
    const attachments = fakeAttachments({ flags: [flag] })
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry, attachments }).plan(request())
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0]!.issues).toEqual([])
    expect(provider.calls).toHaveLength(1)
  })

  it('needs no confirmation without flags or external nodes', async () => {
    const result = await createPlanner({ provider: new FakeProvider([{ data: workflowData(receipts()) }]), registry, attachments: fakeAttachments() }).plan(request())
    expect(result).toMatchObject({ flags: [], needsConfirmation: false })
  })

  it('adds no flags to questions', async () => {
    const attachments = fakeAttachments({ flags: [flag] })
    const result = await createPlanner({ provider: new FakeProvider([{ data: questionsData([question('a')]) }]), registry, attachments }).plan(request())
    expect(result.kind).toBe('questions')
    expect(result).not.toHaveProperty('flags')
    expect(attachments.provenanceCalls).toEqual([])
  })

  it('never sends attachment text in a repair message', async () => {
    const secret = 'SECRET-ATTACHMENT-TEXT'
    const attachments = fakeAttachments({ texts: { a1: secret } })
    const bad = receipts()
    bad.nodes[2]!.config = { file: '/elsewhere/x.csv', row: ['a'] }
    const provider = new FakeProvider([{ data: workflowData(bad) }, { data: workflowData(receipts()) }])
    await createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(request({ attachments: [ref('a1')] }))
    const repair = provider.calls[1]!.request.messages.at(-1)!
    expect(JSON.stringify(repair)).not.toContain(secret)
    expect(attachments.redactCalls[0]!.map((i) => i.code)).toEqual(['path_outside_roots'])
  })
})
