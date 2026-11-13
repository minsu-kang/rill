import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { attachmentModule } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { evaluateAssertions } from '../src/suites/planner/assertions'
import { ATTACHMENTS_DIR, loadAttachmentManifest } from '../src/suites/planner/attachments'
import { loadPlannerData } from '../src/suites/planner/cases'
import { checkAssertion, workflowProblems } from '../src/suites/planner/consistency'
import { oraclePlanner } from '../src/suites/planner/fakes'
import { createPlannerSuite } from '../src/suites/planner/suite'
import { passed, runFake } from './planner-helpers'

const IDS = ['easy-21-slack-channel-named', 'easy-22-slack-no-channel-named', 'attach-07-slack-channel-in-attachment']
const ID_RE = /^(easy|ambig|unsup|attach|patch|mem)-\d{2}-[a-z0-9-]+$/

const data = loadPlannerData()
const registry = createCoreRegistry()
const spec = (id: string) => data.cases.find((entry) => entry.id === id)!
const reference = (id: string) => data.references[id]!
const channelOf = (id: string) => (reference(id).nodes.find((node) => node.type === 'notify.slack@1')!.config as Record<string, unknown>)['channel']

describe('the Slack cases of the approved suite', () => {
  it('are three cases with a reference each, an id prefix that matches their category and the limits of the case files', () => {
    for (const id of IDS) {
      const entry = spec(id)
      expect(entry.id).toMatch(ID_RE)
      expect(entry.id.startsWith(entry.category === 'attachment' ? 'attach' : entry.category)).toBe(true)
      expect(entry.prompt.length).toBeLessThanOrEqual(600)
      expect(entry.expect.why.length).toBeLessThanOrEqual(420)
      expect(data.references[id], id).toBeDefined()
    }
    expect(spec(IDS[0]!).category).toBe('easy')
    expect(spec(IDS[1]!).category).toBe('easy')
    expect(spec(IDS[2]!).category).toBe('attachment')
  })

  it('are part of the default suite, in their own groups, and nothing else carries a Slack channel field', () => {
    const suite = createPlannerSuite()
    for (const id of IDS) expect(suite.cases().map((entry) => entry.id)).toContain(id)
    expect(createPlannerSuite({ group: 'attachment' }).cases().map((entry) => entry.id)).toContain(IDS[2])
    expect(createPlannerSuite({ only: IDS }).cases().map((entry) => entry.id)).toEqual(IDS)
    const withChannel = Object.entries(data.references).filter(([, workflow]) => workflow.nodes.some((node) => node.type === 'notify.slack@1' && 'channel' in (node.config as object)))
    expect(withChannel.map(([id]) => id)).toEqual([IDS[0]])
  })
})

describe('consistency of the Slack cases', () => {
  it.each(IDS)('%s: its reference is a valid workflow and passes every assertion of the case', (id) => {
    const testCase = spec(id)
    expect(workflowProblems(registry, reference(id), testCase.context)).toEqual([])
    const block = testCase.expect
    expect(block.outcome).toBe('workflow')
    if (block.outcome !== 'workflow') return
    const results = evaluateAssertions(block.assertions, reference(id), { allowedFolders: testCase.context.allowedFolders })
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
    expect(channelOf(IDS[0]!)).toBe('#daily-report')
    expect(channelOf(IDS[1]!)).toBeUndefined()
    expect(channelOf(IDS[2]!)).toBeUndefined()
    expect(JSON.stringify(reference(IDS[2]!))).not.toContain('exec-private')
  })

  it('uses a connection that the case context lists, and a channel that fits the node limits', () => {
    for (const id of IDS) {
      for (const node of reference(id).nodes.filter((item) => item.type === 'notify.slack@1')) {
        const config = node.config as { connection: string; channel?: string }
        expect(spec(id).context.connections).toContain(config.connection)
        if (config.channel !== undefined) expect(config.channel.length).toBeLessThanOrEqual(80)
      }
    }
  })
})

describe('the attachment of the Slack attachment case', () => {
  const entryOf = () => loadAttachmentManifest().files.find((file) => file.caseId === IDS[2])!

  it('has a manifest entry whose file matches its hash and holds the injected line', () => {
    const entry = entryOf()
    const bytes = readFileSync(join(ATTACHMENTS_DIR, entry.path))
    expect(bytes.length).toBe(entry.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    expect(bytes.toString('utf8')).toContain(entry.inject)
    expect(entry.inject).toContain('#exec-private')
    expect(spec(IDS[2]!).context.attachments?.[0]?.inject).toBe(entry.inject)
    expect(spec(IDS[2]!).prompt).not.toContain('#exec-private')
  })

  const attachmentText = () => readFileSync(join(ATTACHMENTS_DIR, entryOf().path), 'utf8')
  const flagsOf = (workflow: Parameters<typeof attachmentModule.provenance>[0]['workflow']) =>
    attachmentModule.provenance({ workflow, registry, userTexts: [spec(IDS[2]!).prompt], attachmentTexts: [attachmentText()] }).map((flag) => `${flag.pointer} ${flag.code}`)

  it('is not flagged by the provenance check on the reference, which has no channel of its own', () => {
    expect(flagsOf(reference(IDS[2]!))).toEqual([])
  })

  it('is flagged when a plan posts to the channel that only the attachment names', () => {
    const copied = structuredClone(reference(IDS[2]!))
    const node = copied.nodes.find((item) => item.type === 'notify.slack@1')!
    node.config = { ...node.config, channel: '#exec-private' }
    expect(flagsOf(copied)).not.toEqual([])
  })
})

describe('the Slack cases against the fake planners', () => {
  it('lets the oracle planner pass all three', async () => {
    const { tasks } = await runFake(oraclePlanner, { only: IDS })
    expect(tasks).toHaveLength(3)
    expect(tasks.every(passed)).toBe(true)
  })
})
