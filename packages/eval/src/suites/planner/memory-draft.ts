import { readFileSync } from 'node:fs'
import Type from 'typebox'
import { DATA_DIR, VOCABULARY_PATH, type PlannerData } from './cases'
import { casesSchema, parseReferences, parseVocabulary, schemaProblems, type CaseSpec, type References } from './schema'

export const MEMORY_DRAFT_DIR = `${DATA_DIR}memory-draft/`
export const MEMORY_DRAFT_CASES_PATH = `${MEMORY_DRAFT_DIR}cases.draft.json`
export const MEMORY_DRAFT_REFERENCES_PATH = `${MEMORY_DRAFT_DIR}references.draft.json`
export const MEMORY_DRAFT_ATTACHMENTS_DIR = `${MEMORY_DRAFT_DIR}attachments`
export const MEMORY_DRAFT_SIZE = 7

const strict = { additionalProperties: false } as const
const text = Type.String({ minLength: 1 })

const pairSchema = Type.Object({ with: text, without: text, reuses: text }, strict)

export const memoryDraftSchema = Type.Object(
  {
    status: Type.Literal('DRAFT'),
    notice: Type.String({ pattern: '^DRAFT: not approved\\.' }),
    pairs: Type.Array(pairSchema),
    cases: casesSchema,
  },
  strict,
)

export interface MemoryPair {
  with: string
  without: string
  reuses: string
}

export interface MemoryDraftFile {
  status: 'DRAFT'
  notice: string
  pairs: MemoryPair[]
  cases: CaseSpec[]
}

export interface MemoryDraft extends MemoryDraftFile {
  references: References
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function parseMemoryDraft(input: unknown): MemoryDraftFile {
  const problems = schemaProblems(memoryDraftSchema, input)
  if (problems.length > 0) throw new Error(`invalid memory draft:\n${problems.join('\n')}`)
  return input as MemoryDraftFile
}

export function loadMemoryDraft(): MemoryDraft {
  return { ...parseMemoryDraft(readJson(MEMORY_DRAFT_CASES_PATH)), references: parseReferences(readJson(MEMORY_DRAFT_REFERENCES_PATH)) }
}

export function memoryDraftData(): PlannerData {
  const draft = loadMemoryDraft()
  return { cases: draft.cases, references: draft.references, vocabulary: parseVocabulary(readJson(VOCABULARY_PATH)) }
}
