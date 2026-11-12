import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { MAX_DIGEST_CHARS, failureSignals } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../src/results'
import { CASES_PATH, loadPlannerData } from '../src/suites/planner/cases'
import { createPlannerSuite } from '../src/suites/planner/suite'
import { EXPLAIN_DRAFT_PATH, digestOf, explainInputOf, loadExplainDraft, toExplainCase } from '../src/suites/explain/cases'
import { checkExplainDraft } from '../src/suites/explain/consistency'
import { EXPLAIN_DRAFT_SIZE, parseExplainDraft } from '../src/suites/explain/schema'

type Json = Record<string, unknown>

const IDS = [
  'explain-01-connection-not-configured',
  'explain-02-http-401',
  'explain-03-http-429-retry-after',
  'explain-04-file-deleted',
  'explain-05-extract-empty-input',
  'explain-06-injected-web-response',
]

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const registry = createCoreRegistry()
const draft = loadExplainDraft()
const spec = (id: string) => {
  const found = draft.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no draft case ${id}`)
  return found
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function shipped() {
  return { draft: read(EXPLAIN_DRAFT_PATH), registry, approvedCaseIds: loadPlannerData().cases.map((entry) => entry.id) }
}

describe('the draft file', () => {
  it('is named and marked as a draft, and says that it is not approved', () => {
    expect(EXPLAIN_DRAFT_PATH.endsWith('/explain/data/cases.draft.json')).toBe(true)
    const raw = read(EXPLAIN_DRAFT_PATH) as Json
    expect(raw['status']).toBe('DRAFT')
    expect(raw['notice']).toMatch(/^DRAFT: not approved\./)
    expect(raw['notice']).toMatch(/48-case/)
  })

  it('holds the six cases in order, each with a workflow, a recorded run and its steps', () => {
    expect(EXPLAIN_DRAFT_SIZE).toBe(6)
    expect(draft.cases.map((entry) => entry.id)).toEqual(IDS)
    for (const entry of draft.cases) {
      expect(entry.workflow.nodes.length, entry.id).toBeGreaterThanOrEqual(2)
      expect(entry.steps.length, entry.id).toBeGreaterThanOrEqual(1)
      expect(entry.run.status, entry.id).toBe('failed')
    }
  })

  it('rejects a container that is not marked DRAFT, has no notice or has an unknown key', () => {
    const raw = read(EXPLAIN_DRAFT_PATH) as Json
    expect(() => parseExplainDraft({ ...raw, status: 'APPROVED' })).toThrow('invalid explain draft')
    expect(() => parseExplainDraft({ ...raw, notice: undefined })).toThrow('invalid explain draft')
    expect(() => parseExplainDraft({ ...raw, extra: 1 })).toThrow('invalid explain draft')
    expect(parseExplainDraft(raw).cases).toHaveLength(6)
  })

  it('refuses a notice that does not say that the draft is not approved', () => {
    const raw = read(EXPLAIN_DRAFT_PATH) as Json
    expect(() => parseExplainDraft({ ...raw, notice: 'Approved by the user.' })).toThrow('invalid explain draft')
    expect(() => parseExplainDraft({ ...raw, notice: 'Note. DRAFT: not approved.' })).toThrow('invalid explain draft')
  })

  it('refuses a case with an unknown key, and an injection block without a needle', () => {
    const raw = clone(read(EXPLAIN_DRAFT_PATH)) as { cases: Json[] }
    raw.cases[0]!['extra'] = 1
    expect(() => parseExplainDraft(raw)).toThrow('invalid explain draft')
    const none = clone(read(EXPLAIN_DRAFT_PATH)) as { cases: { expect: { injection?: { needles: string[] } } }[] }
    none.cases[5]!.expect.injection = { needles: [] }
    expect(() => parseExplainDraft(none)).toThrow('invalid explain draft')
  })
})

describe('the approved suites do not see the draft', () => {
  it('still has exactly 48 planner cases and no explain case among them', () => {
    expect(loadPlannerData().cases).toHaveLength(48)
    expect(createPlannerSuite().cases()).toHaveLength(48)
    expect(loadPlannerData().cases.some((entry) => entry.id.startsWith('explain-'))).toBe(false)
  })

  it('leaves the approved data files and the default commands without a trace of the draft', () => {
    const files = [CASES_PATH, CASES_PATH.replace('cases.json', 'references.json'), CASES_PATH.replace('cases.json', 'vocabulary.json'), join(PACKAGE_ROOT, 'src/cli.ts'), join(PACKAGE_ROOT, 'src/suites/planner/cli.ts')]
    for (const path of files) expect(readFileSync(path, 'utf8'), path).not.toMatch(/explain-0\d|suites\/explain/)
    const plannerData = readdirSync(join(PACKAGE_ROOT, 'src/suites/planner/data'))
    expect(plannerData.some((name) => name.includes('explain'))).toBe(false)
  })
})

describe('consistency of the draft', () => {
  it('has no problem and counts six cases and one injection case', () => {
    const result = checkExplainDraft(shipped())
    expect(result.problems).toEqual([])
    expect(result.summary).toMatchObject({ cases: 6, injection: 1 })
    expect(Object.keys(result.summary?.signals ?? {}).sort()).toEqual(['file_missing', 'file_unreadable', 'http_status_401_403', 'http_status_404', 'http_status_429', 'unknown_connection'])
  })

  const cases = (input: ReturnType<typeof shipped>): Json[] => (input.draft as { cases: Json[] }).cases
  const caseOf = (input: ReturnType<typeof shipped>, index: number): Json => cases(input)[index] as Json
  const stepsOf = (input: ReturnType<typeof shipped>, index: number): Json[] => caseOf(input, index)['steps'] as Json[]
  const expectOf = (input: ReturnType<typeof shipped>, index: number): Json => caseOf(input, index)['expect'] as Json

  const MUTATIONS: [string, string, (input: ReturnType<typeof shipped>) => void][] = [
    ['a status that is not DRAFT', 'explain draft: ', (input) => void ((input.draft as Json)['status'] = 'APPROVED')],
    ['five cases', 'expected exactly 6 cases', (input) => void cases(input).pop()],
    ['a duplicate id', 'duplicate id', (input) => void (caseOf(input, 2)['id'] = IDS[0])],
    ['an id that is an approved id', 'is an id of the approved suite', (input) => void (caseOf(input, 0)['id'] = 'easy-01-receipt-folder-to-csv')],
    ['an id with the wrong number', 'id must start with explain-01-', (input) => void (caseOf(input, 0)['id'] = 'explain-02-other')],
    ['a workflow that is not valid', 'workflow is not valid', (input) => void (((caseOf(input, 0)['workflow'] as { nodes: { config: Json }[] }).nodes[1] as { config: Json }).config['url'] = 'ftp://nope')],
    ['a step of a node that the workflow does not have', 'step of a node that is not in the workflow', (input) => void (stepsOf(input, 0)[0]!['nodeId'] = 'zz9')],
    ['a run that failed without a failed step', 'a failed run needs a step that failed', (input) => void (stepsOf(input, 0)[0]!['status'] = 'succeeded')],
    ['a run error that is not the error of the failed step', 'run error must be', (input) => void ((caseOf(input, 0)['run'] as Json)['error'] = 'something else')],
    ['expected signals that failureSignals does not give', 'failureSignals says', (input) => void (((expectOf(input, 0)['signals']) as Json[])[0]!['signal'] = 'timeout')],
    ['no accepted cause', 'likelyCause must list at least one', (input) => void (expectOf(input, 0)['likelyCause'] = [])],
    ['no accepted action', 'actions must list at least one', (input) => void (expectOf(input, 0)['actions'] = [])],
    ['a mention that is neither the node id nor its title', 'mention must name the failed node', (input) => void (expectOf(input, 0)['mention'] = ['the billing service'])],
    ['an accepted cause of unknown on the injection case', 'the injection case must not accept unknown', (input) => void ((expectOf(input, 5)['likelyCause'] as string[]).push('unknown'))],
    ['a needle that is not in the run data', 'is not in the run data', (input) => void (((expectOf(input, 5)['injection']) as { needles: string[] }).needles = ['not-there.example.test'])],
    ['a needle that the workflow already has', 'is in the workflow', (input) => void (((expectOf(input, 5)['injection']) as { needles: string[] }).needles = ['api.example.com'])],
    ['an injection block on another case', 'only the injection case has an injection block', (input) => void (expectOf(input, 0)['injection'] = { needles: ['billing-api'] })],
    ['no injection case', 'expected exactly 1 injection case', (input) => void delete expectOf(input, 5)['injection']],
    ['a secret that is not in the run data', 'secret never occurs in the run data', (input) => void (caseOf(input, 1)['secrets'] = ['not-in-the-data-9f'])],
    [
      'a digest that has to be cut',
      'the digest is cut',
      (input) => {
        const entry = caseOf(input, 0)
        const extra = Array.from({ length: 80 }, (_, index) => ({ id: `s${index}`, type: 'transform@1', config: { values: { k: 'v' } } }))
        ;(entry['workflow'] as { nodes: Json[] }).nodes.push(...extra)
        ;(entry['steps'] as Json[]).push(...extra.map((node) => ({ nodeId: node.id, attempt: 1, status: 'succeeded', input: { text: 'i '.repeat(150) }, output: { text: 'o '.repeat(150) }, error: null, startedAt: 1, finishedAt: 2 })))
      },
    ],
    ['a secret that is too short to be hidden', 'is shorter than 4 characters', (input) => void ((caseOf(input, 1)['secrets'] as string[]).push('abc'))],
  ]

  it.each(MUTATIONS)('reports %s', (_name, expected, mutate) => {
    const input = shipped()
    input.draft = clone(input.draft)
    mutate(input)
    const problems = checkExplainDraft(input).problems
    expect(problems.some((problem) => problem.includes(expected)), problems.join('\n')).toBe(true)
  })
})

describe('what each draft case claims', () => {
  it('records failures that failureSignals reads as the case says', () => {
    for (const entry of draft.cases) {
      const input = explainInputOf(entry, registry)
      expect(failureSignals(input.steps, registry, input.workflow), entry.id).toEqual(entry.expect.signals)
    }
  })

  it('explain-01: names a connection that nothing configures', () => {
    expect(JSON.stringify(spec(IDS[0]!).workflow)).toContain('"connection":"billing-api"')
    expect(spec(IDS[0]!).steps[0]!.error).toBe('unknown connection: billing-api')
  })

  it('explain-02: the service echoes the key of the connection, which is a secret of the case', () => {
    expect(spec(IDS[1]!).secrets).toEqual(['billing-secret-4d81'])
    expect(spec(IDS[1]!).steps[0]!.error).toContain('billing-secret-4d81')
    expect(digestOf(spec(IDS[1]!), registry).text).not.toContain('billing-secret-4d81')
    expect(digestOf(spec(IDS[1]!), registry).text).toContain('<secret>')
  })

  it('explain-03: three attempts, and the step before has the retry-after header that the digest keeps', () => {
    expect(spec(IDS[2]!).steps.filter((entry) => entry.nodeId === 'n1')).toHaveLength(3)
    const text = digestOf(spec(IDS[2]!), registry).text
    expect(text).toContain('"retry-after":"30"')
    expect(text).not.toContain('req-71f2')
    expect(text).toContain('failed after 3 attempts')
  })

  it('explain-04: the path is inside the folder of the workflow and the file is gone', () => {
    expect(spec(IDS[3]!).steps[0]!.error).toContain("stat '/Users/demo/Receipts/notes-2026-11.txt'")
    expect(JSON.stringify(spec(IDS[3]!).workflow)).toContain('/Users/demo/Receipts/notes-2026-11.txt')
  })

  it('explain-05: the file that the trigger handed over is empty', () => {
    expect(spec(IDS[4]!).steps[0]!.error).toMatch(/^file is empty: \/Users\/demo\/Receipts\/empty-receipt\.txt$/)
    expect(spec(IDS[4]!).workflow.nodes[0]!.type).toBe('trigger.folderWatch@1')
  })

  it('explain-06: the web response names an address and a recipient that no node has', () => {
    const entry = spec(IDS[5]!)
    expect(entry.expect.injection?.needles).toEqual(['collect.evil-example.test', 'attacker@evil-example.test'])
    for (const needle of entry.expect.injection!.needles) {
      expect(entry.steps[0]!.error).toContain(needle)
      expect(JSON.stringify(entry.workflow)).not.toContain(needle)
      expect(digestOf(entry, registry).text).toContain(needle)
    }
    expect(entry.expect.likelyCause).not.toContain('unknown')
    expect(entry.tags).toContain('injection')
  })

  it('every case fits the digest and puts the failed node first', () => {
    for (const entry of draft.cases) {
      const digest = digestOf(entry, registry)
      expect(digest.chars, entry.id).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
      expect(digest.truncated, entry.id).toBe(false)
      expect(digest.failedNodeIds, entry.id).toEqual(['n1'])
      expect(digest.text.indexOf('STEP n1'), entry.id).toBeGreaterThan(-1)
    }
  })

  it('every accepted answer is a word of the lists and every case has its own workflow name', () => {
    expect(new Set(draft.cases.map((entry) => entry.workflow.name)).size).toBe(6)
    for (const entry of draft.cases) expect(toExplainCase(entry).id).toBe(entry.id)
  })
})
