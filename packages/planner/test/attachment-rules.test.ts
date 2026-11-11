import { describe, expect, it, vi } from 'vitest'
import { PLANNER_RULES, createPlanner, type AttachmentStore } from '../src/index'
import { FakeProvider } from './fake-provider'
import { fakeAttachments, receipts, ref, registry, request, workflowData } from './fixtures'

vi.mock('../src/attachments', () => ({
  ATTACHMENT_RULES: 'ATTACHMENT RULES',
  attachmentModule: { prepare: async () => ({ parts: [], texts: [] }), provenance: () => [], redactIssues: (issues: unknown) => issues },
}))

const store: AttachmentStore = { read: async () => new Uint8Array([1]) }

describe('attachment rules in the system prompt', () => {
  it('appends the rules when this message has attachments', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry, attachments: fakeAttachments(), attachmentStore: store }).plan(request({ attachments: [ref('a')] }))
    expect((provider.calls[0]!.request.system as { text: string }[])[0]!.text).toBe(`${PLANNER_RULES}\n\nATTACHMENT RULES`)
  })

  it('appends the rules when an earlier turn has attachments', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const turns = [{ role: 'user' as const, text: 'x', attachments: [ref('a')] }, { role: 'assistant' as const, text: 'y' }]
    await createPlanner({ provider, registry, attachments: fakeAttachments(), attachmentStore: store }).plan(request({ turns }))
    expect((provider.calls[0]!.request.system as { text: string }[])[0]!.text).toContain('ATTACHMENT RULES')
  })

  it('leaves the rules alone without attachments', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry }).plan(request())
    expect((provider.calls[0]!.request.system as { text: string }[])[0]!.text).toBe(PLANNER_RULES)
  })
})
