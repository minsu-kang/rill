import { readFileSync } from 'node:fs'
import { createCoreRegistry } from '@rill/nodes-core'
import { MAX_DIGEST_CHARS, failureSignals } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { EXPLAIN_CASES_PATH, digestOf, explainInputOf, loadExplainData, toExplainCase } from '../src/suites/explain/cases'
import { checkExplainCases } from '../src/suites/explain/consistency'
import { EXPLAIN_CASE_COUNT, parseExplainData } from '../src/suites/explain/schema'
import { loadPlannerData } from '../src/suites/planner/cases'
import { createExplainSuite } from '../src/suites/explain/suite'

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
const approved = loadExplainData()
const spec = (id: string) => {
  const found = approved.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no explain case ${id}`)
  return found
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function shipped() {
  return { data: read(EXPLAIN_CASES_PATH), registry, plannerCaseIds: loadPlannerData().cases.map((entry) => entry.id) }
}

describe('the explain data file', () => {
  it('is the approved file: it holds only the cases and carries no draft marker', () => {
    expect(EXPLAIN_CASES_PATH.endsWith('/explain/data/cases.json')).toBe(true)
    const raw = read(EXPLAIN_CASES_PATH) as Json
    expect(Object.keys(raw)).toEqual(['cases'])
    expect(readFileSync(EXPLAIN_CASES_PATH, 'utf8')).not.toMatch(/draft|not approved/iu)
  })

  it('holds the six cases in order, each with a workflow, a recorded run and its steps', () => {
    expect(EXPLAIN_CASE_COUNT).toBe(6)
    expect(approved.cases.map((entry) => entry.id)).toEqual(IDS)
    for (const entry of approved.cases) {
      expect(entry.workflow.nodes.length, entry.id).toBeGreaterThanOrEqual(2)
      expect(entry.steps.length, entry.id).toBeGreaterThanOrEqual(1)
      expect(entry.run.status, entry.id).toBe('failed')
    }
  })

  it('rejects a container with a status marker, a notice or any unknown key, and accepts the shipped one', () => {
    const raw = read(EXPLAIN_CASES_PATH) as Json
    expect(() => parseExplainData({ ...raw, status: 'DRAFT' })).toThrow('invalid explain data')
    expect(() => parseExplainData({ ...raw, notice: 'DRAFT: not approved.' })).toThrow('invalid explain data')
    expect(() => parseExplainData({ ...raw, extra: 1 })).toThrow('invalid explain data')
    expect(() => parseExplainData([])).toThrow('invalid explain data')
    expect(parseExplainData(raw).cases).toHaveLength(6)
  })

  it('refuses a case with an unknown key, and an injection block without a needle', () => {
    const raw = clone(read(EXPLAIN_CASES_PATH)) as { cases: Json[] }
    raw.cases[0]!['extra'] = 1
    expect(() => parseExplainData(raw)).toThrow('invalid explain data')
    const none = clone(read(EXPLAIN_CASES_PATH)) as { cases: { expect: { injection?: { needles: string[] } } }[] }
    none.cases[5]!.expect.injection = { needles: [] }
    expect(() => parseExplainData(none)).toThrow('invalid explain data')
  })
})

describe('the default explain suite', () => {
  it('loads the six approved cases without being handed any data, in the group explain', () => {
    const suite = createExplainSuite()
    expect(suite.cases().map((entry) => entry.id)).toEqual(IDS)
    expect(new Set(suite.cases().map((entry) => entry.group))).toEqual(new Set(['explain']))
    expect(suite.cases().filter((entry) => entry.category === 'injection').map((entry) => entry.id)).toEqual([IDS[5]])
  })

  it('is the same suite as the one handed the approved data, and changes its version when a case changes', () => {
    expect(createExplainSuite().version).toBe(createExplainSuite({ data: approved }).version)
    const changed = { ...approved, cases: approved.cases.map((entry, index) => (index === 0 ? { ...entry, title: `${entry.title}!` } : entry)) }
    expect(createExplainSuite({ data: changed }).version).not.toBe(createExplainSuite().version)
  })

  it('keeps its ids apart from the ids of the planner cases', () => {
    const planner = new Set(loadPlannerData().cases.map((entry) => entry.id))
    for (const id of IDS) expect(planner.has(id), id).toBe(false)
  })
})

describe('consistency of the explain cases', () => {
  it('has no problem and counts six cases and one injection case', () => {
    const result = checkExplainCases(shipped())
    expect(result.problems).toEqual([])
    expect(result.summary).toMatchObject({ cases: 6, injection: 1 })
    expect(Object.keys(result.summary?.signals ?? {}).sort()).toEqual(['file_missing', 'file_unreadable', 'http_status_401_403', 'http_status_404', 'http_status_429', 'unknown_connection'])
  })

  const cases = (input: ReturnType<typeof shipped>): Json[] => (input.data as { cases: Json[] }).cases
  const caseOf = (input: ReturnType<typeof shipped>, index: number): Json => cases(input)[index] as Json
  const stepsOf = (input: ReturnType<typeof shipped>, index: number): Json[] => caseOf(input, index)['steps'] as Json[]
  const expectOf = (input: ReturnType<typeof shipped>, index: number): Json => caseOf(input, index)['expect'] as Json

  const MUTATIONS: [string, string, (input: ReturnType<typeof shipped>) => void][] = [
    ['a status marker', 'explain data: ', (input) => void ((input.data as Json)['status'] = 'DRAFT')],
    ['five cases', 'expected exactly 6 cases', (input) => void cases(input).pop()],
    ['a duplicate id', 'duplicate id', (input) => void (caseOf(input, 2)['id'] = IDS[0])],
    ['an id that is the id of a planner case', 'is an id of a planner case', (input) => void (caseOf(input, 0)['id'] = 'easy-01-receipt-folder-to-csv')],
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
    input.data = clone(input.data)
    mutate(input)
    const problems = checkExplainCases(input).problems
    expect(problems.some((problem) => problem.includes(expected)), problems.join('\n')).toBe(true)
  })
})

describe('what each explain case claims', () => {
  it('records failures that failureSignals reads as the case says', () => {
    for (const entry of approved.cases) {
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
    for (const entry of approved.cases) {
      const digest = digestOf(entry, registry)
      expect(digest.chars, entry.id).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
      expect(digest.truncated, entry.id).toBe(false)
      expect(digest.failedNodeIds, entry.id).toEqual(['n1'])
      expect(digest.text.indexOf('STEP n1'), entry.id).toBeGreaterThan(-1)
    }
  })

  it('every accepted answer is a word of the lists and every case has its own workflow name', () => {
    expect(new Set(approved.cases.map((entry) => entry.workflow.name)).size).toBe(6)
    for (const entry of approved.cases) expect(toExplainCase(entry).id).toBe(entry.id)
  })
})
