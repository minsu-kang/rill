import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { evaluateAssertions } from '../src/suites/planner/assertions'
import { loadAttachmentManifest } from '../src/suites/planner/attachments'
import { CASES_PATH, loadPlannerData } from '../src/suites/planner/cases'
import { checkAssertion, workflowProblems } from '../src/suites/planner/consistency'
import { oraclePlanner } from '../src/suites/planner/fakes'
import { CATEGORIES } from '../src/suites/planner/schema'
import {
  SLACK_DRAFT_ATTACHMENTS_DIR,
  SLACK_DRAFT_CASES_PATH,
  SLACK_DRAFT_REFERENCES_PATH,
  SLACK_DRAFT_SIZE,
  loadSlackDraft,
  parseSlackDraft,
  slackDraftData,
} from '../src/suites/planner/slack-draft'
import { createPlannerSuite, type PlannerSuiteOptions } from '../src/suites/planner/suite'
import { passed, runFake } from './planner-helpers'

const IDS = ['easy-21-slack-channel-named', 'easy-22-slack-no-channel-named', 'attach-07-slack-channel-in-attachment']
const ID_RE = /^(easy|ambig|unsup|attach|patch)-\d{2}-[a-z0-9-]+$/

const draft = loadSlackDraft()
const approved = loadPlannerData()
const registry = createCoreRegistry()
const options: PlannerSuiteOptions = { data: slackDraftData(), files: { plannerDir: SLACK_DRAFT_ATTACHMENTS_DIR } }
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const spec = (id: string) => draft.cases.find((entry) => entry.id === id)!

describe('the Slack draft file', () => {
  it('is named and marked as a draft, and says that it is not approved', () => {
    expect(SLACK_DRAFT_CASES_PATH.endsWith('/slack-draft/cases.draft.json')).toBe(true)
    expect(SLACK_DRAFT_REFERENCES_PATH.endsWith('/slack-draft/references.draft.json')).toBe(true)
    const raw = read(SLACK_DRAFT_CASES_PATH) as Record<string, unknown>
    expect(raw['status']).toBe('DRAFT')
    expect(raw['notice']).toMatch(/^DRAFT: not approved\./)
    expect(raw['notice']).toMatch(/48-case/)
  })

  it('holds three cases with fixed ids, a category prefix that matches, and a reference for each', () => {
    expect(draft.cases.map((entry) => entry.id)).toEqual(IDS)
    expect(draft.cases).toHaveLength(SLACK_DRAFT_SIZE)
    expect(Object.keys(draft.references).sort()).toEqual([...IDS].sort())
    for (const entry of draft.cases) {
      expect(entry.id).toMatch(ID_RE)
      expect(entry.id.startsWith(entry.category === 'ambiguous' ? 'ambig' : entry.category === 'unsupported' ? 'unsup' : entry.category === 'attachment' ? 'attach' : entry.category)).toBe(true)
      expect(entry.prompt.length).toBeLessThanOrEqual(600)
      expect(entry.expect.why.length).toBeLessThanOrEqual(420)
    }
  })

  it('refuses a file that is not marked as a draft or has an extra key', () => {
    const file = read(SLACK_DRAFT_CASES_PATH) as Record<string, unknown>
    expect(() => parseSlackDraft({ ...file, status: 'APPROVED' })).toThrow('invalid Slack draft')
    expect(() => parseSlackDraft({ ...file, notice: 'approved' })).toThrow('invalid Slack draft')
    expect(() => parseSlackDraft({ ...file, extra: 1 })).toThrow('invalid Slack draft')
  })
})

describe('the approved suite does not see the Slack draft', () => {
  it('still loads exactly 48 cases and none of the draft ids', () => {
    expect(approved.cases).toHaveLength(48)
    expect(approved.cases.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(IDS))
    expect(approved.cases.some((entry) => IDS.includes(entry.id))).toBe(false)
  })

  it('keeps the draft out of the default suite and leaves the approved data files without a trace of it', () => {
    const suite = createPlannerSuite()
    expect(suite.cases()).toHaveLength(48)
    expect(suite.cases().some((entry) => IDS.includes(entry.id))).toBe(false)
    for (const path of [CASES_PATH, CASES_PATH.replace('cases.json', 'references.json')]) {
      const text = readFileSync(path, 'utf8')
      for (const id of IDS) expect(text).not.toContain(id)
      expect(text).not.toContain('"channel"')
    }
    expect((CATEGORIES as readonly string[]).includes('slack')).toBe(false)
  })

  it('runs the draft only when the caller hands it over', () => {
    const suite = createPlannerSuite(options)
    expect(suite.cases().map((entry) => entry.id)).toEqual(IDS)
    expect(suite.version).not.toBe(createPlannerSuite().version)
  })
})

describe('consistency of the Slack draft', () => {
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

  it('has a channel on the first reference only where the user named one', () => {
    const channelOf = (id: string) => (draft.references[id]!.nodes.find((node) => node.type === 'notify.slack@1')!.config as Record<string, unknown>)['channel']
    expect(channelOf(IDS[0]!)).toBe('#daily-report')
    expect(channelOf(IDS[1]!)).toBeUndefined()
    expect(channelOf(IDS[2]!)).toBeUndefined()
    expect(JSON.stringify(draft.references[IDS[2]!])).not.toContain('exec-private')
  })

  it('uses a connection that the case context lists, and a channel that fits the node limits', () => {
    for (const entry of draft.cases) {
      for (const node of draft.references[entry.id]!.nodes.filter((item) => item.type === 'notify.slack@1')) {
        const config = node.config as { connection: string; channel?: string }
        expect(entry.context.connections).toContain(config.connection)
        if (config.channel !== undefined) expect(config.channel.length).toBeLessThanOrEqual(80)
      }
    }
  })
})

describe('the attachment of the Slack draft', () => {
  it('has a manifest entry whose file matches its hash and holds the injected line', () => {
    const manifest = loadAttachmentManifest(SLACK_DRAFT_ATTACHMENTS_DIR)
    expect(manifest.files.map((file) => file.caseId)).toEqual([IDS[2]])
    const [entry] = manifest.files
    const bytes = readFileSync(join(SLACK_DRAFT_ATTACHMENTS_DIR, entry!.path))
    expect(bytes.length).toBe(entry!.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry!.sha256)
    expect(bytes.toString('utf8')).toContain(entry!.inject)
    expect(entry!.inject).toContain('#exec-private')
    expect(spec(IDS[2]!).context.attachments?.[0]?.inject).toBe(entry!.inject)
  })
})

describe('the Slack draft against the fake planners', () => {
  it('lets the oracle planner pass all three cases', async () => {
    const { tasks } = await runFake(oraclePlanner, options)
    expect(tasks).toHaveLength(3)
    expect(tasks.every(passed)).toBe(true)
  })
})
