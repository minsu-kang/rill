import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CASES_PATH, PAIRS_PATH, REFERENCES_PATH, goldNodeTypes, loadPlannerData, toPlannerCase } from '../src/suites/planner/cases'
import { parseCases, parsePairs, parseReferences, parseVocabulary, schemaProblems, casesSchema } from '../src/suites/planner/schema'

const data = loadPlannerData()
const byId = (id: string) => {
  const found = data.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('loadPlannerData', () => {
  it('loads 61 cases, 43 references, the memory pair and the vocabulary', () => {
    expect(data.cases).toHaveLength(61)
    expect(Object.keys(data.references)).toHaveLength(43)
    expect(data.pairs).toEqual([{ with: 'mem-01-folder-from-note', without: 'mem-02-same-request-without-memory', reuses: 'ambig-01-which-folder' }])
    expect(data.vocabulary.version).toBe(1)
    expect(new Set(data.cases.map((entry) => entry.id)).size).toBe(61)
  })

  it('holds every case of the approved set: the refusal of Google Sheets is gone and its replacement is a workflow case', () => {
    const ids = data.cases.map((entry) => entry.id)
    expect(ids).not.toContain('unsup-02-google-sheets')
    expect(byId('easy-25-google-sheet-one-connection').expect.outcome).toBe('workflow')
    for (const id of [
      'easy-21-slack-channel-named',
      'easy-22-slack-no-channel-named',
      'attach-07-slack-channel-in-attachment',
      'easy-23-google-sheet-row',
      'easy-24-excel-file-and-table',
      'attach-08-spreadsheet-id-in-attachment',
    ]) {
      expect(ids, id).toContain(id)
    }
    expect(ids.filter((id) => id.startsWith('mem-'))).toHaveLength(7)
    expect(ids.filter((id) => id.startsWith('mem-')).every((id) => byId(id).category === 'memory')).toBe(true)
  })

  it('carries no draft marker in the case or reference files', () => {
    for (const path of [CASES_PATH, REFERENCES_PATH, PAIRS_PATH]) expect(readFileSync(path, 'utf8'), path).not.toMatch(/draft|DRAFT|"status"|"notice"/u)
  })
})

describe('parsers', () => {
  it('reject an unknown key, a bad enum and a missing field', () => {
    const first = structuredClone(data.cases[0])
    expect(() => parseCases([{ ...first, extra: 1 }])).toThrow('invalid planner cases')
    expect(() => parseCases([{ ...first, category: 'hard' }])).toThrow('invalid planner cases')
    expect(() => parseCases([{ ...first, prompt: undefined }])).toThrow('invalid planner cases')
    expect(parseCases([first])).toHaveLength(1)
    expect(schemaProblems(casesSchema, [first], 0)).toEqual([])
    expect(schemaProblems(casesSchema, 5)[0]).toMatch(/^\/: /)
  })
  it('reject a reference that is not a workflow and a vocabulary without assertions', () => {
    expect(() => parseReferences({ a: { schemaVersion: 2 } })).toThrow('invalid planner references')
    expect(() => parseVocabulary({ version: 1 })).toThrow('invalid planner vocabulary')
  })
  it('reject a pair without its third id, with an empty id or with an extra key, and accept the shipped pair', () => {
    const [pair] = data.pairs
    expect(() => parsePairs([{ with: 'a', without: 'b' }])).toThrow('invalid planner pairs')
    expect(() => parsePairs([{ with: 'a', without: '', reuses: 'c' }])).toThrow('invalid planner pairs')
    expect(() => parsePairs([{ ...pair, extra: 1 }])).toThrow('invalid planner pairs')
    expect(() => parsePairs({})).toThrow('invalid planner pairs')
    expect(parsePairs([pair])).toEqual([pair])
  })
})

describe('toPlannerCase', () => {
  it('maps a spec onto the eval case fields', () => {
    const testCase = toPlannerCase(byId('easy-08-png-to-slack-slang'), data.references)
    expect(testCase).toMatchObject({
      id: 'easy-08-png-to-slack-slang',
      group: 'easy',
      category: 'easy',
      kind: 'workflow',
      tags: ['hard', 'slang', 'mixed'],
    })
    expect(testCase.expected).toBe(testCase.spec.expect)
    expect(testCase.references).toEqual([data.references['easy-08-png-to-slack-slang']])
  })
  it('has no gold workflow for a case that expects questions or a refusal', () => {
    expect(toPlannerCase(byId('ambig-01-which-folder'), data.references).references).toEqual([])
    expect(toPlannerCase(byId('unsup-01-kakaotalk'), data.references).kind).toBe('unsupported')
  })
  it('collects the reference of every alsoAccept workflow block under its own key', () => {
    const spec = byId('easy-01-receipt-folder-to-csv')
    const alt = { ...(data.references[spec.id] as object), name: 'alt' }
    const references = { ...data.references, [`${spec.id}#alsoAccept0`]: alt, [`${spec.id}x`]: alt } as typeof data.references
    expect(toPlannerCase(spec, references).references).toHaveLength(2)
  })
  it('lists the node types of the gold workflow', () => {
    expect([...goldNodeTypes(toPlannerCase(byId('easy-01-receipt-folder-to-csv'), data.references))].sort()).toEqual(
      ['csv.append@1', 'llm.extract@1', 'trigger.folderWatch@1'],
    )
    expect(goldNodeTypes(toPlannerCase(byId('ambig-01-which-folder'), data.references)).size).toBe(0)
  })
})

describe('the package index', () => {
  it('exports the planner suite, its CLI, the fakes and the report next to the extract suite', async () => {
    const index = (await import('../src/index')) as Record<string, unknown>
    for (const name of [
      'createPlannerSuite',
      'plannerMain',
      'parsePlannerCli',
      'renderPlannerReport',
      'plannerMetrics',
      'scorePlannerCase',
      'oraclePlanner',
      'nullPlanner',
      'perturbedPlanner',
      'copyingPlanner',
      'checkPlannerConsistency',
      'plannerEvaluateExpectation',
      'generatePlannerAttachments',
      'plannerWorstCaseCalls',
      'createExtractSuite',
    ]) {
      expect(typeof index[name], name).toBe('function')
    }
    expect(index['PLANNER_FIELDS']).toEqual(['outcome', 'checks'])
  })
})
