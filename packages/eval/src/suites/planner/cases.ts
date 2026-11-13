import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Workflow } from '@rill/dsl'
import type { EvalCase } from '../../suite'
import { parseCases, parsePairs, parseReferences, parseVocabulary, type CaseSpec, type MemoryPair, type References, type Vocabulary } from './schema'

export const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))
export const CASES_PATH = `${DATA_DIR}cases.json`
export const REFERENCES_PATH = `${DATA_DIR}references.json`
export const PAIRS_PATH = `${DATA_DIR}pairs.json`
export const VOCABULARY_PATH = `${DATA_DIR}vocabulary.json`

export interface PlannerCase extends EvalCase {
  prompt: string
  spec: CaseSpec
  expected: CaseSpec['expect']
  references: Workflow[]
}

export interface PlannerData {
  cases: CaseSpec[]
  references: References
  pairs: MemoryPair[]
  vocabulary: Vocabulary
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadPlannerData(): PlannerData {
  return {
    cases: parseCases(readJson(CASES_PATH)),
    references: parseReferences(readJson(REFERENCES_PATH)),
    pairs: parsePairs(readJson(PAIRS_PATH)),
    vocabulary: parseVocabulary(readJson(VOCABULARY_PATH)),
  }
}

export function toPlannerCase(spec: CaseSpec, references: References): PlannerCase {
  return {
    id: spec.id,
    group: spec.category,
    category: spec.category,
    tags: [...(spec.tags ?? []), spec.language],
    kind: spec.expect.outcome,
    prompt: spec.prompt,
    spec,
    expected: spec.expect,
    references: Object.entries(references)
      .filter(([key]) => key === spec.id || key.startsWith(`${spec.id}#alsoAccept`))
      .map(([, workflow]) => workflow),
  }
}

export function goldNodeTypes(testCase: PlannerCase): Set<string> {
  return new Set(testCase.references.flatMap((workflow) => workflow.nodes.map((node) => node.type)))
}
