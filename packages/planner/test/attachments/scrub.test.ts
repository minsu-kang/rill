import { createCoreRegistry } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { scrubResultText, type ScrubInput } from '../../src/attachments/scrub'
import type { PlanResultBody } from '../../src/types'
import { receipts } from '../fixtures'

const registry = createCoreRegistry()
const RECEIPT = 'Receipt from Quokkaplatypus Fennecwombat\nInvoice INV-2024-0042 at https://pay.quokka.example/r/9\nTotal 12.50'

const input = (rest: Partial<ScrubInput> = {}): ScrubInput => ({
  attachmentTexts: [RECEIPT],
  userTexts: ['Put the receipts into my ledger'],
  registry,
  ...rest,
})

type WorkflowBody = Extract<PlanResultBody, { kind: 'workflow' }>

const workflowBody = (summary: string): WorkflowBody => ({
  kind: 'workflow',
  workflow: receipts(),
  summary,
  flags: [{ nodeId: 'n2', pointer: '/config/file', code: 'attachment_origin', message: 'node n2: /config/file holds a value' }],
  needsConfirmation: true,
})

function summaryOf(body: PlanResultBody): string {
  return body.summary
}

describe('scrubResultText', () => {
  it('hides a word that only the attachment has', () => {
    const out = scrubResultText(workflowBody('Waits after receipts from Quokkaplatypus Fennecwombat'), input())
    expect(summaryOf(out)).not.toMatch(/quokkaplatypus|fennecwombat/i)
    expect(summaryOf(out)).toContain('<hidden>')
    expect(summaryOf(out)).toContain('receipts')
  })

  it('hides a word whatever its case', () => {
    expect(summaryOf(scrubResultText(workflowBody('QUOKKAPLATYPUS pays'), input()))).not.toMatch(/quokkaplatypus/i)
  })

  it('keeps words of the user texts, of the catalog and of the existing workflow', () => {
    const summary = 'Appends the receipts to a csv row for Fennecwombat'
    const out = scrubResultText(workflowBody(summary), input({ attachmentTexts: [`${RECEIPT} receipts csv row append`], userTexts: ['Fennecwombat receipts please'] }))
    expect(summaryOf(out)).toBe(summary)
    const existing = receipts()
    existing.nodes[2]!.config = { file: '/x/quokkaplatypus.csv', row: ['a'] }
    expect(summaryOf(scrubResultText(workflowBody('Writes quokkaplatypus.csv'), input({ existingWorkflow: existing })))).toContain('quokkaplatypus')
  })

  it('hides an identifier or a link of the attachment as a whole', () => {
    const out = scrubResultText(workflowBody('Files INV-2024-0042 from https://pay.quokka.example/r/9 and ftp://files.other.net/drop'), input())
    const summary = summaryOf(out)
    expect(summary).not.toContain('INV-2024-0042')
    expect(summary).not.toContain('pay.quokka.example')
    expect(summary).toContain('ftp://files.other.net/drop')
  })

  it('hides an identifier whatever its case', () => {
    expect(summaryOf(scrubResultText(workflowBody('Files inv-2024-0042 now'), input()))).not.toMatch(/inv-2024-0042/i)
  })

  it('keeps an identifier that the user wrote too', () => {
    const out = scrubResultText(workflowBody('Files INV-2024-0042 now'), input({ userTexts: ['file invoice inv-2024-0042 in my ledger'] }))
    expect(summaryOf(out)).toBe('Files INV-2024-0042 now')
  })

  it('scrubs every free text of a questions result', () => {
    const body: PlanResultBody = {
      kind: 'questions',
      summary: 'Is it Quokkaplatypus?',
      questions: [{ id: 'q1', text: 'Is Fennecwombat the vendor?', options: ['Quokkaplatypus', 'someone else'], default: 'Quokkaplatypus' }],
    }
    const out = scrubResultText(body, input())
    expect(JSON.stringify(out)).not.toMatch(/quokkaplatypus|fennecwombat/i)
    if (out.kind !== 'questions') throw new Error('kind')
    expect(out.questions[0]!.id).toBe('q1')
    expect(out.questions[0]!.options[1]).toBe('someone else')
    expect(out.questions[0]!.default).toBe(out.questions[0]!.options[0])
  })

  it('scrubs the reason, the nearest node and the summary of an unsupported result', () => {
    const body: PlanResultBody = { kind: 'unsupported', reason: 'Quokkaplatypus wants mail', nearest: 'Fennecwombat mail', summary: 'No mail for Quokkaplatypus' }
    expect(JSON.stringify(scrubResultText(body, input()))).not.toMatch(/quokkaplatypus|fennecwombat/i)
  })

  it('leaves the workflow, the flags and the patch alone', () => {
    const body = workflowBody('Quokkaplatypus')
    const out = scrubResultText({ ...body, patch: [{ op: 'remove_node', nodeId: 'n2' }] }, input())
    if (out.kind !== 'workflow') throw new Error('kind')
    expect(out.workflow).toEqual(receipts())
    expect(out.flags).toEqual(body.flags)
    expect(out.patch).toEqual([{ op: 'remove_node', nodeId: 'n2' }])
    expect(out.needsConfirmation).toBe(true)
  })

  it('changes nothing without attachment text', () => {
    const body = workflowBody('Quokkaplatypus INV-2024-0042')
    expect(scrubResultText(body, input({ attachmentTexts: [] }))).toEqual(body)
  })

  it('does not change its argument', () => {
    const body = workflowBody('Quokkaplatypus')
    const before = structuredClone(body)
    scrubResultText(body, input())
    expect(body).toEqual(before)
  })
})
