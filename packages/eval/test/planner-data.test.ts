import { describe, expect, it } from 'vitest'
import { goldNodeTypes, loadPlannerData, toPlannerCase } from '../src/suites/planner/cases'
import { parseCases, parseReferences, parseVocabulary, schemaProblems, casesSchema } from '../src/suites/planner/schema'

const data = loadPlannerData()
const byId = (id: string) => {
  const found = data.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('loadPlannerData', () => {
  it('loads 48 cases, 30 references and the vocabulary', () => {
    expect(data.cases).toHaveLength(48)
    expect(Object.keys(data.references)).toHaveLength(30)
    expect(data.vocabulary.version).toBe(1)
    expect(new Set(data.cases.map((entry) => entry.id)).size).toBe(48)
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
