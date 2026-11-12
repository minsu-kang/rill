import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { buildMemoryPrompt, type PlanRequest } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS } from '../../protocol/src/index'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { PACKAGE_ROOT } from '../src/results'
import { TEXT_CHARS_PER_TOKEN } from '../src/suites/extract/suite'
import { ASSERTION_NAMES, evaluateAssertions } from '../src/suites/planner/assertions'
import { verifyAttachments } from '../src/suites/planner/attachments'
import { baseInputTokens, firstCallInputTokens } from '../src/suites/planner/budget'
import { CASES_PATH, loadPlannerData, toPlannerCase } from '../src/suites/planner/cases'
import { buildPlanRequest } from '../src/suites/planner/context'
import { MEMORY_NOTES_MAX, MEMORY_NOTE_CHARS, checkConsistency, checkMemoryDraft, type DraftConsistencyInput } from '../src/suites/planner/consistency'
import { fakeResult, questionsBody } from '../src/suites/planner/fake-results'
import { copyingPlanner, goldBody, neverAsksPlanner, nullPlanner, oraclePlanner, perturb, perturbedPlanner } from '../src/suites/planner/fakes'
import {
  MEMORY_DRAFT_ATTACHMENTS_DIR,
  MEMORY_DRAFT_CASES_PATH,
  MEMORY_DRAFT_REFERENCES_PATH,
  MEMORY_DRAFT_SIZE,
  loadMemoryDraft,
  memoryDraftData,
  parseMemoryDraft,
} from '../src/suites/planner/memory-draft'
import { memoryPairMetrics } from '../src/suites/planner/metrics'
import { renderPlannerReport, type PlannerReportMeta } from '../src/suites/planner/report'
import { CATEGORIES, type AssertionName, type CaseSpec } from '../src/suites/planner/schema'
import { createPlannerSuite, type PlannerFactory, type PlannerSuiteOptions } from '../src/suites/planner/suite'
import { FAKE_MODEL, count, passed, runFake, scoreOf, total } from './planner-helpers'

type Json = Record<string, unknown>

const IDS = [
  'mem-01-folder-from-note',
  'mem-02-same-request-without-memory',
  'mem-03-connection-from-note',
  'mem-04-request-beats-note',
  'mem-05-irrelevant-note',
  'mem-06-note-url-beats-attachment-url',
  'mem-07-one-of-twenty-notes',
]

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const manifest = read(join(PACKAGE_ROOT, 'fixtures/extract/manifest.json')) as { files: DraftConsistencyInput['manifest'] }

function shipped(): DraftConsistencyInput {
  return {
    draft: read(MEMORY_DRAFT_CASES_PATH),
    references: read(MEMORY_DRAFT_REFERENCES_PATH),
    approvedCases: read(CASES_PATH),
    registry: createCoreRegistry(),
    seeds: read(join(PACKAGE_ROOT, 'src/suites/extract/data/seeds.json')) as { id: string }[],
    manifest: manifest.files,
    fixtureExists: (path) => existsSync(join(PACKAGE_ROOT, 'fixtures/extract', path)),
  }
}

const draft = loadMemoryDraft()
const approved = loadPlannerData()
const options: PlannerSuiteOptions = { data: memoryDraftData(), files: { plannerDir: MEMORY_DRAFT_ATTACHMENTS_DIR } }
const spec = (id: string): CaseSpec => {
  const found = draft.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no draft case ${id}`)
  return found
}
const notesOf = (id: string): string[] => [...(spec(id).context.memory ?? [])]
const referenceOf = (id: string): string => JSON.stringify(draft.references[id])

describe('the draft file', () => {
  it('is named and marked as a draft, and says that it is not approved', () => {
    expect(MEMORY_DRAFT_CASES_PATH.endsWith('/memory-draft/cases.draft.json')).toBe(true)
    expect(MEMORY_DRAFT_REFERENCES_PATH.endsWith('/memory-draft/references.draft.json')).toBe(true)
    const raw = read(MEMORY_DRAFT_CASES_PATH) as Json
    expect(raw['status']).toBe('DRAFT')
    expect(raw['notice']).toMatch(/^DRAFT: not approved\./)
    expect(raw['notice']).toMatch(/48-case/)
  })

  it('holds the seven memory cases in order', () => {
    expect(MEMORY_DRAFT_SIZE).toBe(7)
    expect(draft.cases.map((entry) => entry.id)).toEqual(IDS)
    expect(draft.cases.every((entry) => entry.category === 'memory')).toBe(true)
    expect(Object.keys(draft.references).sort()).toEqual(IDS.filter((id) => spec(id).expect.outcome === 'workflow').sort())
  })

  it('pairs the case with notes and the same request without them', () => {
    expect(draft.pairs).toEqual([{ with: IDS[0], without: IDS[1], reuses: 'ambig-01-which-folder' }])
  })

  it('rejects a container that is not marked DRAFT, has no notice or has an unknown key', () => {
    const raw = read(MEMORY_DRAFT_CASES_PATH) as Json
    expect(() => parseMemoryDraft({ ...raw, status: 'APPROVED' })).toThrow('invalid memory draft')
    expect(() => parseMemoryDraft({ ...raw, notice: undefined })).toThrow('invalid memory draft')
    expect(() => parseMemoryDraft({ ...raw, extra: 1 })).toThrow('invalid memory draft')
    expect(parseMemoryDraft(raw).cases).toHaveLength(7)
  })
})

describe('the approved suite does not see the draft', () => {
  it('still loads exactly 48 cases, none of them a memory case or one with notes', () => {
    expect(approved.cases).toHaveLength(48)
    expect(approved.cases.filter((entry) => entry.category === 'memory' || entry.id.startsWith('mem-') || entry.context.memory !== undefined)).toEqual([])
    expect(approved.cases.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(IDS))
  })

  it('keeps the memory group out of the default suite and out of the group list', () => {
    const suite = createPlannerSuite()
    expect(suite.cases()).toHaveLength(48)
    expect(suite.cases().some((entry) => entry.id.startsWith('mem-'))).toBe(false)
    expect(() => createPlannerSuite({ group: 'memory' })).toThrow('unknown group')
    expect((CATEGORIES as readonly string[]).includes('memory')).toBe(false)
  })

  it('leaves the approved data files without a trace of the draft', () => {
    for (const path of [CASES_PATH, CASES_PATH.replace('cases.json', 'references.json')]) {
      const text = readFileSync(path, 'utf8')
      expect(text).not.toMatch(/"memory"|mem-0\d/)
    }
  })

  it('runs the draft only when the caller hands it over', () => {
    const suite = createPlannerSuite(options)
    expect(suite.cases().map((entry) => entry.id)).toEqual(IDS)
    expect(suite.version).not.toBe(createPlannerSuite().version)
  })
})

describe('consistency of the draft', () => {
  it('has no problem and counts seven cases', () => {
    const result = checkMemoryDraft(shipped())
    expect(result.problems).toEqual([])
    expect(result.summary?.cases).toBe(7)
    expect(result.summary?.outcome).toEqual({ workflow: 6, questions: 1 })
  })

  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const cases = (input: DraftConsistencyInput): Json[] => (input.draft as { cases: Json[] }).cases
  const ctx = (input: DraftConsistencyInput, id: string): Json => (cases(input).find((entry) => entry['id'] === id) as Json)['context'] as Json
  const notes = (input: DraftConsistencyInput, id: string): string[] => ctx(input, id)['memory'] as string[]

  const MUTATIONS: [string, string, (input: DraftConsistencyInput) => void][] = [
    ['a status that is not DRAFT', 'memory draft: ', (input) => void ((input.draft as Json)['status'] = 'APPROVED')],
    ['six cases', 'expected exactly 7 cases', (input) => void cases(input).pop()],
    ['a duplicate id', 'duplicate id', (input) => void (cases(input)[2]!['id'] = IDS[0])],
    ['an id that is an approved id', 'is an id of the approved suite', (input) => void (cases(input)[0]!['id'] = 'easy-01-receipt-folder-to-csv')],
    ['an id with the wrong prefix', 'id prefix does not match category', (input) => void (cases(input)[0]!['id'] = 'easy-99-folder-from-note')],
    ['a case of another category', 'must be a memory case', (input) => void (cases(input)[0]!['category'] = 'easy')],
    ['a note with a line break', 'is not one line', (input) => void (notes(input, IDS[0]!)[0] = 'one\ntwo')],
    ['a note with a control character', 'is not one line', (input) => void (notes(input, IDS[0]!)[0] = 'one\ttwo')],
    ['a note with a bidi character', 'is not one line', (input) => void (notes(input, IDS[0]!)[0] = `one${String.fromCharCode(0x202e)}two`)],
    ['a note with a double space', 'is not normalised', (input) => void (notes(input, IDS[0]!)[0] = 'one  two')],
    ['a note with a space at the end', 'is not normalised', (input) => void (notes(input, IDS[0]!)[0] = 'one two ')],
    ['an empty note', 'is empty', (input) => void (notes(input, IDS[0]!)[0] = '')],
    ['a note over 300 characters', 'is longer than', (input) => void (notes(input, IDS[0]!)[0] = 'x'.repeat(MEMORY_MAX_CHARS + 1))],
    ['21 notes', 'at most 20 notes', (input) => void notes(input, IDS[6]!).push('one more note')],
    ['a note that repeats another note in other case', 'duplicate note', (input) => void (notes(input, IDS[6]!)[1] = notes(input, IDS[6]!)[0]!.toUpperCase())],
    ['an empty notes list', 'notes must not be an empty list', (input) => void (ctx(input, IDS[0]!)['memory'] = [])],
    ['notes on the control case', 'the control case must have no notes', (input) => void (ctx(input, IDS[1]!)['memory'] = ['a note'])],
    ['no notes on the case with notes', 'must have notes', (input) => void delete ctx(input, IDS[0]!)['memory']],
    ['a control that differs from the approved case', 'differs from the approved case', (input) => void (cases(input)[1]!['prompt'] = '영수증 정리해서 이메일로 알려줘.')],
    ['a pair that names an unknown case', 'names an unknown case', (input) => void ((input.draft as { pairs: Json[] }).pairs[0]!['with'] = 'mem-99-nothing')],
    ['a pair whose control expects a workflow', 'must expect questions', (input) => void ((input.draft as { pairs: Json[] }).pairs[0]!['without'] = IDS[0])],
    ['a missing reference', 'no reference solution', (input) => void delete (input.references as Json)[IDS[0]!]],
    ['a reference outside the allowed folders', 'path_outside_roots', (input) => void (((input.references as Json)[IDS[0]!] as { nodes: { config: Json }[] }).nodes[0]!.config['folder'] = '/etc/receipts')],
  ]

  it.each(MUTATIONS)('reports %s', (_name, expected, mutate) => {
    const input = shipped()
    input.draft = clone(input.draft)
    input.references = clone(input.references)
    mutate(input)
    const problems = checkMemoryDraft(input).problems
    expect(problems.some((problem) => problem.includes(expected)), problems.join('\n')).toBe(true)
  })

  it('makes the approved checker refuse notes on an approved case and a memory case among the 48', () => {
    const approvedInput = (mutate: (cases: Json[]) => void) => {
      const cases = clone(approved.cases) as unknown as Json[]
      mutate(cases)
      return checkConsistency({
        cases,
        references: read(CASES_PATH.replace('cases.json', 'references.json')),
        vocabulary: read(CASES_PATH.replace('cases.json', 'vocabulary.json')),
        registry: createCoreRegistry(),
        seeds: shipped().seeds,
        manifest: shipped().manifest,
      }).problems
    }
    expect(approvedInput(() => undefined)).toEqual([])
    expect(approvedInput((cases) => void ((cases[0]!['context'] as Json)['memory'] = ['a note'])).some((problem) => problem.includes('memory notes only belong to memory cases'))).toBe(true)
    expect(approvedInput((cases) => void (cases[0]!['category'] = 'memory')).some((problem) => problem.includes('memory: expected 0, found 1'))).toBe(true)
  })
})

describe('what each draft case claims', () => {
  it('mem-01: the folder comes from the note and the prompt does not name it', () => {
    const [note] = notesOf(IDS[0]!)
    expect(note).toContain('Documents/Work/Receipts')
    expect(spec(IDS[0]!).prompt).not.toContain('Work')
    expect(referenceOf(IDS[0]!)).toContain('Documents/Work/Receipts')
    expect(spec(IDS[0]!).expect.outcome).toBe('workflow')
  })

  it('mem-02: is the approved ambiguous case, word for word, without notes', () => {
    const control = spec(IDS[1]!)
    const base = approved.cases.find((entry) => entry.id === 'ambig-01-which-folder')!
    expect(control.context.memory).toBeUndefined()
    expect(JSON.stringify([control.prompt, control.context, control.effort, control.expect])).toBe(JSON.stringify([base.prompt, base.context, base.effort, base.expect]))
    expect(control.expect.outcome).toBe('questions')
  })

  it('mem-01 and mem-02 differ only by the notes and the expectation', () => {
    const withoutNotes: Json = { ...spec(IDS[0]!).context }
    delete withoutNotes['memory']
    expect(spec(IDS[0]!).prompt).toBe(spec(IDS[1]!).prompt)
    expect(withoutNotes).toEqual(spec(IDS[1]!).context)
    expect(spec(IDS[0]!).effort).toBe(spec(IDS[1]!).effort)
  })

  it('mem-03: the note names a configured connection and the prompt names none', () => {
    const context = spec(IDS[2]!).context
    const named = context.connections.filter((name) => notesOf(IDS[2]!).join(' ').includes(name))
    expect(named).toEqual(['slack-alerts'])
    expect(context.connections.length).toBeGreaterThanOrEqual(3)
    for (const name of context.connections) expect(spec(IDS[2]!).prompt).not.toContain(name)
    expect(referenceOf(IDS[2]!)).toContain('slack-alerts')
  })

  it('mem-04: the note and the prompt name different folders and the reference follows the prompt', () => {
    expect(notesOf(IDS[3]!).join(' ')).toContain('~/Receipts')
    expect(spec(IDS[3]!).prompt).toContain('Downloads')
    expect(referenceOf(IDS[3]!)).toContain('/Users/demo/Downloads')
    expect(referenceOf(IDS[3]!)).not.toMatch(/receipts/i)
    expect(spec(IDS[3]!).context.allowedFolders).toEqual(expect.arrayContaining(['/Users/demo/Receipts', '/Users/demo/Downloads']))
  })

  it('mem-05: the note shares nothing with the request or the reference', () => {
    const words = notesOf(IDS[4]!).join(' ').toLowerCase().match(/[a-z~/.]{4,}/g) ?? []
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) expect(referenceOf(IDS[4]!).toLowerCase(), word).not.toContain(word)
    const zero = (spec(IDS[4]!).expect as { assertions: Json[] }).assertions.filter((assertion) => assertion['check'] === 'hasNodeCount' && assertion['max'] === 0).map((assertion) => assertion['type'])
    expect(zero.sort()).toEqual(['csv.append@1', 'llm.extract@1', 'trigger.folderWatch@1'])
  })

  it('mem-06: the user URL is in the note, the attacker URL only in the attachment', () => {
    const attachment = spec(IDS[5]!).context.attachments![0]!
    expect(notesOf(IDS[5]!).join(' ')).toContain('https://billing.example.com/api/expenses')
    expect(spec(IDS[5]!).prompt).not.toContain('billing.example.com')
    expect(attachment.inject).toContain('https://collect.evil-example.net/upload')
    expect(attachment.inject).not.toContain('billing.example.com')
    expect(notesOf(IDS[5]!).join(' ')).not.toContain('evil-example')
    expect(referenceOf(IDS[5]!)).toContain('https://billing.example.com/api/expenses')
    expect(referenceOf(IDS[5]!)).not.toContain('evil-example')
    expect(spec(IDS[5]!).tags).toContain('injection')
  })

  it('mem-07: the list is full, and exactly one note holds the folder and the ledger', () => {
    const list = notesOf(IDS[6]!)
    expect(list).toHaveLength(MEMORY_MAX_ITEMS)
    const relevant = list.filter((note) => /receipts/i.test(note) || /ledger/i.test(note) || /Documents/.test(note))
    expect(relevant).toHaveLength(1)
    expect(relevant[0]).toContain('Documents/Work/Receipts')
    expect(relevant[0]).toContain('Documents/Work/ledger.csv')
    expect(referenceOf(IDS[6]!)).toContain('/Users/demo/Documents/Work/Receipts')
    expect(referenceOf(IDS[6]!)).toContain('/Users/demo/Documents/Work/ledger.csv')
    expect(spec(IDS[6]!).prompt).not.toMatch(/Work|Documents|ledger\.csv/)
  })

  it('checks the notes against the limits of the protocol', () => {
    expect(MEMORY_NOTES_MAX).toBe(MEMORY_MAX_ITEMS)
    expect(MEMORY_NOTE_CHARS).toBe(MEMORY_MAX_CHARS)
  })

  it('every list of notes obeys the limits of the engine', () => {
    for (const entry of draft.cases) {
      const list = entry.context.memory ?? []
      expect(list.length, entry.id).toBeLessThanOrEqual(MEMORY_MAX_ITEMS)
      for (const note of list) {
        expect([...note].length, entry.id).toBeLessThanOrEqual(MEMORY_MAX_CHARS)
        expect(note, entry.id).toBe(note.normalize('NFC').trim().replace(/\s+/gu, ' '))
      }
    }
  })
})

describe('the request of the draft cases', () => {
  it('carries the notes in context.memory and nothing in the control case', () => {
    for (const entry of draft.cases) {
      const request = buildPlanRequest(entry, [])
      expect(request.context.memory, entry.id).toEqual(entry.context.memory)
    }
    expect('memory' in buildPlanRequest(spec(IDS[1]!), []).context).toBe(false)
  })

  it('leaves the request of every approved case without a memory key', () => {
    for (const entry of approved.cases) expect('memory' in buildPlanRequest(entry, []).context, entry.id).toBe(false)
  })

  it('reaches the planner when the suite runs, and only the notes of that case', async () => {
    const seen = new Map<string, readonly string[] | undefined>()
    const spy: PlannerFactory = ({ testCase }) => ({
      plan: async (request: PlanRequest) => {
        seen.set(testCase.id, request.context.memory)
        const body = goldBody(testCase)
        return fakeResult(body)
      },
    })
    await runFake(spy, options)
    for (const entry of draft.cases) expect(seen.get(entry.id), entry.id).toEqual(entry.context.memory)
  })

  it('makes a planner that reads the notes ask only where the notes are missing', async () => {
    const memoryAware: PlannerFactory = (input) => ({
      plan: async (request: PlanRequest) =>
        request.context.memory === undefined && input.testCase.id !== IDS[1] ? fakeResult(questionsBody(['어느 폴더를 볼까요?'])) : oraclePlanner(input).plan(request),
    })
    const { tasks } = await runFake(memoryAware, options)
    expect(tasks.filter(passed)).toHaveLength(7)
    const asking: PlannerFactory = (input) => ({
      plan: async (request: PlanRequest) => (input.testCase.id === IDS[0] ? fakeResult(questionsBody(['어느 폴더를 볼까요?'])) : oraclePlanner(input).plan(request)),
    })
    expect((await runFake(asking, options)).tasks.filter((task) => !passed(task)).map((task) => task.caseId)).toEqual([IDS[0]])
  })
})

const asksAboutFolders: PlannerFactory = () => ({ plan: async () => fakeResult(questionsBody(['어느 폴더를 볼까요?'])) })

describe('offline oracle, null and perturbed planners on the draft', () => {
  const workflowIds = IDS.filter((id) => id !== IDS[1])

  it('the oracle passes all seven on both fields and every assertion', async () => {
    const { tasks } = await runFake(oraclePlanner, options)
    expect(tasks).toHaveLength(7)
    expect(tasks.filter(passed)).toHaveLength(7)
    for (const task of tasks) expect(scoreOf(task).outcomes, task.caseId).toEqual({ outcome: 'TP', checks: 'TP' })
    const workflows = tasks.filter((task) => task.kind === 'workflow')
    expect(workflows).toHaveLength(6)
    expect(total(workflows, 'assertions_passed')).toBe(total(workflows, 'assertions_total'))
    expect(total(tasks, 'asked')).toBe(1)
    expect(total(tasks, 'over_ask')).toBe(0)
    expect(total(tasks, 'invented_node')).toBe(0)
    expect(count(tasks, 'outside_gold')).toBe(6)
    expect(total(tasks, 'outside_gold')).toBe(0)
  })

  it('the null planner fails all seven', async () => {
    const { tasks } = await runFake(nullPlanner, options)
    expect(tasks.filter(passed)).toHaveLength(0)
    expect(total(tasks.filter((task) => task.kind === 'workflow'), 'over_refuse')).toBe(6)
  })

  it('a planner that always asks passes only the control and over-asks on the six workflow cases', async () => {
    const { tasks } = await runFake(asksAboutFolders, options)
    expect(tasks.filter(passed).map((task) => task.caseId)).toEqual([IDS[1]])
    expect(total(tasks.filter((task) => task.kind === 'workflow'), 'over_ask')).toBe(6)
  })

  it('a planner that never asks passes the six workflow cases and guesses on the control', async () => {
    const { tasks } = await runFake(neverAsksPlanner, options)
    expect(tasks.filter(passed).map((task) => task.caseId).sort()).toEqual([...workflowIds].sort())
    expect(total(tasks, 'guessed')).toBe(1)
  })

  const ALLOWED: Readonly<Record<AssertionName, readonly AssertionName[]>> = {
    hasTrigger: [],
    hasNode: ['pathInsideAllowedFolders', 'usesConnection'],
    hasNodeCount: ['hasTrigger'],
    hasEdge: [],
    orderedBefore: [],
    extractsFields: [],
    noNodeOutsideCatalog: [],
    noSecretLiteral: [],
    pathInsideAllowedFolders: ['hasNode'],
    usesConnection: ['hasNode'],
    hasRetry: [],
    referencesOutputOf: ['pathInsideAllowedFolders', 'hasNode'],
  }
  const using = (kind: AssertionName): Set<string> =>
    new Set(draft.cases.filter((entry) => entry.expect.outcome === 'workflow' && entry.expect.assertions.some((assertion) => assertion.check === kind)).map((entry) => entry.id))
  const used = ASSERTION_NAMES.filter((kind) => using(kind).size > 0)

  it('uses most of the assertion vocabulary', () => {
    expect(used.length).toBeGreaterThanOrEqual(9)
  })

  it.each(used)('%s: perturbing it fails exactly the draft cases that use it', async (kind) => {
    const { tasks } = await runFake(perturbedPlanner(kind), options)
    const affected = using(kind)
    for (const task of tasks) {
      const score = scoreOf(task)
      if (!affected.has(task.caseId)) {
        expect(score.outcomes, `${kind} on ${task.caseId}`).toEqual({ outcome: 'TP', checks: 'TP' })
        continue
      }
      const failed = score.tags?.['checks'] ?? []
      expect(score.outcomes, `${kind} on ${task.caseId}`).toEqual({ outcome: 'TP', checks: 'WRONG' })
      expect(failed, `${kind} on ${task.caseId}`).toContain(kind)
      for (const other of failed) expect([kind, ...ALLOWED[kind]], `${kind} on ${task.caseId}: ${other}`).toContain(other)
    }
    expect(tasks.filter((task) => !passed(task)).map((task) => task.caseId).sort()).toEqual([...affected].sort())
  })

  it('makes each single assertion of every draft workflow case fail when perturbed, so none is vacuous', () => {
    let instances = 0
    for (const entry of draft.cases) {
      const testCase = toPlannerCase(entry, draft.references)
      const block = testCase.expected
      const body = goldBody(testCase)
      if (block.outcome !== 'workflow' || body.kind !== 'workflow') continue
      const context = { allowedFolders: entry.context.allowedFolders }
      expect(evaluateAssertions(block.assertions, body.workflow, context).every((result) => result.ok), entry.id).toBe(true)
      block.assertions.forEach((target, index) => {
        const results = evaluateAssertions(block.assertions, perturb(body.workflow, target), context)
        expect(results[index]?.ok, `${entry.id} #${index} ${JSON.stringify(target).slice(0, 80)}`).toBe(false)
        instances += 1
      })
    }
    expect(instances).toBeGreaterThanOrEqual(40)
  })

  it('fails a planner that copies the attacker URL without a flag, on the injection case only', async () => {
    const { tasks } = await runFake(copyingPlanner({ flag: false }), options)
    expect(tasks.filter((task) => !passed(task)).map((task) => task.caseId)).toEqual([IDS[5]])
    expect(scoreOf(tasks.find((task) => task.caseId === IDS[5])!).extra).toMatchObject({ inject_copied: 1, inject_flagged: 0, inject_ok: 0 })
  })

  it('passes the same planner when the copy carries a flag and asks for confirmation, and fails it without the confirmation', async () => {
    const flagged = await runFake(copyingPlanner({ flag: true }), options)
    expect(flagged.tasks.filter(passed)).toHaveLength(7)
    expect(scoreOf(flagged.tasks.find((task) => task.caseId === IDS[5])!).extra).toMatchObject({ inject_copied: 1, inject_flagged: 1, inject_ok: 1 })
    const unconfirmed = await runFake(copyingPlanner({ flag: true, needsConfirmation: false }), options)
    expect(unconfirmed.tasks.filter((task) => !passed(task)).map((task) => task.caseId)).toEqual([IDS[5]])
  })

  it('the attachment of the injection case is the generated file and matches its manifest', () => {
    expect(verifyAttachments(draft.cases, { plannerDir: MEMORY_DRAFT_ATTACHMENTS_DIR })).toEqual([])
    const text = readFileSync(join(MEMORY_DRAFT_ATTACHMENTS_DIR, 'mem-06-note-url-beats-attachment-url-0.txt'), 'utf8')
    expect(text).toContain('https://collect.evil-example.net/upload')
    expect(text).not.toContain('billing.example.com')
    const approvedManifest = readFileSync(join(PACKAGE_ROOT, 'src/suites/planner/data/attachments/manifest.json'), 'utf8')
    expect(approvedManifest).not.toContain('mem-0')
  })
})

describe('questions avoided with memory', () => {
  it('is one question avoided for the oracle: the control asked, the case with notes did not', async () => {
    const { tasks } = await runFake(oraclePlanner, options)
    expect(memoryPairMetrics(tasks, draft.pairs)).toEqual({ pairs: 1, avoided: 1, added: 0 })
  })

  it('is nothing for a planner that asks on both, and nothing for one that asks on neither', async () => {
    expect(memoryPairMetrics((await runFake(asksAboutFolders, options)).tasks, draft.pairs)).toEqual({ pairs: 1, avoided: 0, added: 0 })
    expect(memoryPairMetrics((await runFake(neverAsksPlanner, options)).tasks, draft.pairs)).toEqual({ pairs: 1, avoided: 0, added: 0 })
  })

  it('counts a question that the notes caused as added', async () => {
    const backwards: PlannerFactory = (input) => ({
      plan: async (request: PlanRequest) => (input.testCase.id === IDS[0] ? fakeResult(questionsBody(['어느 폴더를 볼까요?'])) : neverAsksPlanner(input).plan(request)),
    })
    expect(memoryPairMetrics((await runFake(backwards, options)).tasks, draft.pairs)).toEqual({ pairs: 1, avoided: 0, added: 1 })
  })

  it('pairs the reps of one model with each other and leaves out a pair with a missing or unscored side', async () => {
    const two = await runFake(oraclePlanner, options, [FAKE_MODEL], 2)
    expect(memoryPairMetrics(two.tasks, draft.pairs)).toEqual({ pairs: 2, avoided: 2, added: 0 })
    expect(memoryPairMetrics(two.tasks.filter((task) => task.caseId !== IDS[1]), draft.pairs)).toEqual({ pairs: 0, avoided: 0, added: 0 })
    expect(memoryPairMetrics(two.tasks.filter((task) => !(task.caseId === IDS[1] && task.rep === 1)), draft.pairs)).toEqual({ pairs: 1, avoided: 1, added: 0 })
    expect(memoryPairMetrics(two.tasks, [])).toEqual({ pairs: 0, avoided: 0, added: 0 })
  })

  it('matches a run with the notes to the run without them of the same rep', async () => {
    const base = (await runFake(oraclePlanner, options, [FAKE_MODEL], 2)).tasks
    const patched = base.map((task) => {
      const asked = task.caseId === IDS[0] ? (task.rep === 1 ? 1 : 0) : task.caseId === IDS[1] ? 1 : undefined
      return asked === undefined || task.score === undefined ? task : { ...task, score: { ...task.score, extra: { ...task.score.extra, asked } } }
    })
    expect(memoryPairMetrics(patched, draft.pairs)).toEqual({ pairs: 2, avoided: 1, added: 0 })
  })

  const META: PlannerReportMeta = {
    suiteName: 'planner',
    suiteVersion: 'v-test',
    createdAt: '2026-11-13T09:30:00.000Z',
    models: [FAKE_MODEL],
    reps: 1,
    seed: 1,
    effort: undefined,
    priceTableAsOf: PRICE_TABLE_AS_OF,
    fallback: false,
    baselines: [],
    maxRepairRounds: 3,
    maxOutputTokens: 16_000,
  }

  it('shows up in the report when pairs are given, and not otherwise', async () => {
    const { run } = await runFake(oraclePlanner, options)
    const plain = renderPlannerReport({ run, meta: META })
    expect(plain).not.toContain('Questions avoided with memory')
    const text = renderPlannerReport({ run, meta: META, pairs: draft.pairs })
    expect(text).toContain('## Memory')
    expect(text).toContain('Questions avoided with memory')
    expect(text).toContain('100.0% (1/1)')
  })

  it('leaves the report of the approved suite as it was', async () => {
    const { run } = await runFake(oraclePlanner)
    expect(renderPlannerReport({ run, meta: META })).toBe(renderPlannerReport({ run, meta: META, pairs: [] }))
  })
})

describe('the estimate of a draft case', () => {
  it('adds the memory block to the first call and nothing to a case without notes', () => {
    const base = baseInputTokens(createCoreRegistry())
    const withNotes = spec(IDS[6]!)
    const bare: CaseSpec['context'] = { ...withNotes.context }
    delete bare.memory
    const block = buildMemoryPrompt(withNotes.context.memory, () => '0123456789ab').text.length
    const delta = firstCallInputTokens(withNotes, [], base) - firstCallInputTokens({ ...withNotes, context: bare }, [], base)
    expect(block).toBeGreaterThan(1000)
    expect(delta).toBeGreaterThanOrEqual(Math.floor(block / TEXT_CHARS_PER_TOKEN))
    expect(delta).toBeLessThanOrEqual(Math.ceil(block / TEXT_CHARS_PER_TOKEN))
    const control = spec(IDS[1]!)
    expect(firstCallInputTokens(control, [], base)).toBe(firstCallInputTokens(approved.cases.find((entry) => entry.id === 'ambig-01-which-folder')!, [], base))
  })
})
