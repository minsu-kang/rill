import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { attachmentModule, connectionKindIssues } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { evaluateAssertions } from '../src/suites/planner/assertions'
import { loadAttachmentManifest } from '../src/suites/planner/attachments'
import { CASES_PATH, loadPlannerData } from '../src/suites/planner/cases'
import { checkAssertion, workflowProblems } from '../src/suites/planner/consistency'
import { CONNECTION_KINDS, SPREADSHEET_DRAFT_CONNECTION_KINDS, buildPlanRequest, connectionsOf } from '../src/suites/planner/context'
import { oraclePlanner } from '../src/suites/planner/fakes'
import { CATEGORIES } from '../src/suites/planner/schema'
import {
  SPREADSHEET_DRAFT_ATTACHMENTS_DIR,
  SPREADSHEET_DRAFT_CASES_PATH,
  SPREADSHEET_DRAFT_REFERENCES_PATH,
  SPREADSHEET_DRAFT_SIZE,
  loadSpreadsheetDraft,
  parseSpreadsheetDraft,
  spreadsheetDraftData,
} from '../src/suites/planner/spreadsheet-draft'
import { createPlannerSuite, type PlannerSuiteOptions } from '../src/suites/planner/suite'
import { passed, runFake } from './planner-helpers'

const IDS = ['easy-23-google-sheet-row', 'easy-24-excel-file-and-table', 'attach-08-spreadsheet-id-in-attachment']
const ID_RE = /^(easy|ambig|unsup|attach|patch)-\d{2}-[a-z0-9-]+$/
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const OTHER = '1QzExecPrivateSheetIdNotTheUsers000'

const draft = loadSpreadsheetDraft()
const approved = loadPlannerData()
const registry = createCoreRegistry()
const options: PlannerSuiteOptions = { data: spreadsheetDraftData(), files: { plannerDir: SPREADSHEET_DRAFT_ATTACHMENTS_DIR } }
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const spec = (id: string) => draft.cases.find((entry) => entry.id === id)!
const nodeOf = (id: string, type: string) => draft.references[id]!.nodes.find((node) => node.type === type)!

describe('the spreadsheet draft file', () => {
  it('is named and marked as a draft, and says that it is not approved', () => {
    expect(SPREADSHEET_DRAFT_CASES_PATH.endsWith('/spreadsheet-draft/cases.draft.json')).toBe(true)
    expect(SPREADSHEET_DRAFT_REFERENCES_PATH.endsWith('/spreadsheet-draft/references.draft.json')).toBe(true)
    const raw = read(SPREADSHEET_DRAFT_CASES_PATH) as Record<string, unknown>
    expect(raw['status']).toBe('DRAFT')
    expect(raw['notice']).toMatch(/^DRAFT: not approved\./)
    expect(raw['notice']).toMatch(/48-case/)
  })

  it('holds three cases with fixed ids, a category prefix that matches, and a reference for each', () => {
    expect(draft.cases.map((entry) => entry.id)).toEqual(IDS)
    expect(draft.cases).toHaveLength(SPREADSHEET_DRAFT_SIZE)
    expect(Object.keys(draft.references).sort()).toEqual([...IDS].sort())
    for (const entry of draft.cases) {
      expect(entry.id).toMatch(ID_RE)
      expect(entry.id.startsWith(entry.category === 'ambiguous' ? 'ambig' : entry.category === 'unsupported' ? 'unsup' : entry.category === 'attachment' ? 'attach' : entry.category)).toBe(true)
      expect(entry.prompt.length).toBeLessThanOrEqual(600)
      expect(entry.expect.why.length).toBeLessThanOrEqual(420)
    }
  })

  it('refuses a file that is not marked as a draft or has an extra key', () => {
    const file = read(SPREADSHEET_DRAFT_CASES_PATH) as Record<string, unknown>
    expect(() => parseSpreadsheetDraft({ ...file, status: 'APPROVED' })).toThrow('invalid spreadsheet draft')
    expect(() => parseSpreadsheetDraft({ ...file, notice: 'approved' })).toThrow('invalid spreadsheet draft')
    expect(() => parseSpreadsheetDraft({ ...file, extra: 1 })).toThrow('invalid spreadsheet draft')
  })
})

describe('the approved suite does not see the spreadsheet draft', () => {
  it('still loads exactly 48 cases and none of the draft ids', () => {
    expect(approved.cases).toHaveLength(48)
    expect(approved.cases.some((entry) => IDS.includes(entry.id))).toBe(false)
  })

  it('keeps the draft out of the default suite and leaves the approved data files without a trace of it', () => {
    const suite = createPlannerSuite()
    expect(suite.cases()).toHaveLength(48)
    expect(suite.cases().some((entry) => IDS.includes(entry.id))).toBe(false)
    for (const path of [CASES_PATH, CASES_PATH.replace('cases.json', 'references.json')]) {
      const text = readFileSync(path, 'utf8')
      for (const id of IDS) expect(text).not.toContain(id)
      for (const word of ['google.sheets.append', 'microsoft.excel.append', 'google-main', 'microsoft-main']) expect(text).not.toContain(word)
    }
    expect((CATEGORIES as readonly string[]).includes('spreadsheet')).toBe(false)
  })

  it('runs the draft only when the caller hands it over', () => {
    const suite = createPlannerSuite(options)
    expect(suite.cases().map((entry) => entry.id)).toEqual(IDS)
    expect(suite.version).not.toBe(createPlannerSuite().version)
  })

  it('keeps the connection names of the approved cases apart from the two draft names', () => {
    const names = new Set(approved.cases.flatMap((entry) => entry.context.connections))
    expect([...names].sort()).toEqual(Object.keys(CONNECTION_KINDS).sort())
    expect(Object.keys(SPREADSHEET_DRAFT_CONNECTION_KINDS).sort()).toEqual(['google-main', 'microsoft-main'])
    for (const name of Object.keys(SPREADSHEET_DRAFT_CONNECTION_KINDS)) expect(names.has(name)).toBe(false)
  })
})

describe('connections of the spreadsheet draft', () => {
  it('gives the two account names their kinds and still refuses an unknown name', () => {
    expect(connectionsOf(['google-main', 'microsoft-main', 'slack-ops'])).toEqual([
      { name: 'google-main', kind: 'google' },
      { name: 'microsoft-main', kind: 'microsoft' },
      { name: 'slack-ops', kind: 'slack' },
    ])
    expect(() => connectionsOf(['mystery'])).toThrow('no connection kind is known for mystery')
  })

  it('builds a request whose context lists the account connections by name and kind only', () => {
    const request = buildPlanRequest(spec(IDS[0]!), [])
    expect(request.context.connections).toEqual([{ name: 'google-main', kind: 'google' }])
  })
})

describe('consistency of the spreadsheet draft', () => {
  it.each(IDS)('%s: its reference is a valid workflow and passes every assertion of the case', (id) => {
    const testCase = spec(id)
    const reference = draft.references[id]!
    expect(workflowProblems(registry, reference, testCase.context)).toEqual([])
    const block = testCase.expect
    expect(block.outcome).toBe('workflow')
    if (block.outcome !== 'workflow') return
    const results = evaluateAssertions(block.assertions, reference, { allowedFolders: testCase.context.allowedFolders })
    expect(results.filter((result) => !result.ok)).toEqual([])
  })

  it.each(IDS)('%s: every assertion is well formed for the registry', (id) => {
    const testCase = spec(id)
    const problems: string[] = []
    if (testCase.expect.outcome !== 'workflow') return
    for (const assertion of testCase.expect.assertions) checkAssertion(registry, (message) => problems.push(message), assertion, testCase.context)
    expect(problems).toEqual([])
  })

  it.each(IDS)('%s: the reference uses connections of the right kind', (id) => {
    const testCase = spec(id)
    expect(connectionKindIssues(draft.references[id]!, registry, connectionsOf(testCase.context.connections))).toEqual([])
  })

  it('uses the google connection for the sheet cases, the microsoft connection for the Excel case, and the id and path the user typed', () => {
    for (const id of [IDS[0]!, IDS[2]!]) {
      const config = nodeOf(id, 'google.sheets.append@1').config as Record<string, unknown>
      expect(config['connection']).toBe('google-main')
      expect(config['spreadsheetId']).toBe(SHEET)
      expect(spec(id).prompt).toContain(SHEET)
    }
    const excel = nodeOf(IDS[1]!, 'microsoft.excel.append@1').config as Record<string, unknown>
    expect(excel).toMatchObject({ connection: 'microsoft-main', filePath: 'Receipts/ledger.xlsx', table: 'Expenses' })
    expect(spec(IDS[1]!).prompt).toContain('Receipts/ledger.xlsx')
    expect(spec(IDS[1]!).prompt).toContain('Expenses')
  })

  it('never lets the other spreadsheet id of the attachment into a reference', () => {
    expect(JSON.stringify(draft.references)).not.toContain(OTHER)
    expect(JSON.stringify(draft.references[IDS[2]!])).not.toContain('QzExec')
  })
})

describe('the attachment of the spreadsheet draft', () => {
  it('has a manifest entry whose file matches its hash and holds the injected line with the other id', () => {
    const manifest = loadAttachmentManifest(SPREADSHEET_DRAFT_ATTACHMENTS_DIR)
    expect(manifest.files.map((file) => file.caseId)).toEqual([IDS[2]])
    const [entry] = manifest.files
    const bytes = readFileSync(join(SPREADSHEET_DRAFT_ATTACHMENTS_DIR, entry!.path))
    expect(bytes.length).toBe(entry!.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry!.sha256)
    expect(bytes.toString('utf8')).toContain(entry!.inject)
    expect(entry!.inject).toContain(OTHER)
    expect(spec(IDS[2]!).context.attachments?.[0]?.inject).toBe(entry!.inject)
    expect(spec(IDS[2]!).prompt).not.toContain(OTHER)
  })
})

describe('the spreadsheet draft against the fake planners', () => {
  it('lets the oracle planner pass all three cases', async () => {
    const { tasks } = await runFake(oraclePlanner, options)
    expect(tasks).toHaveLength(3)
    expect(tasks.every(passed)).toBe(true)
  })
})

describe('the provenance check on the attachment case', () => {
  const attachmentText = () => {
    const [entry] = loadAttachmentManifest(SPREADSHEET_DRAFT_ATTACHMENTS_DIR).files
    return readFileSync(join(SPREADSHEET_DRAFT_ATTACHMENTS_DIR, entry!.path), 'utf8')
  }
  const flagsOf = (workflow: Parameters<typeof attachmentModule.provenance>[0]['workflow']) =>
    attachmentModule.provenance({ workflow, registry, userTexts: [spec(IDS[2]!).prompt], attachmentTexts: [attachmentText()] }).map((flag) => `${flag.pointer} ${flag.code}`)

  it('flags nothing in the reference, which uses the id that the user typed', () => {
    expect(flagsOf(draft.references[IDS[2]!]!)).toEqual([])
  })

  it('flags a plan that appends to the id that only the attachment names', () => {
    const reference = structuredClone(draft.references[IDS[2]!]!)
    const node = reference.nodes.find((item) => item.type === 'google.sheets.append@1')!
    node.config = { ...node.config, spreadsheetId: OTHER }
    expect(flagsOf(reference)).toEqual(['/nodes/2/config/spreadsheetId attachment_origin', '/nodes/2/config/spreadsheetId new_egress_target'])
  })
})
