import { readFileSync } from 'node:fs'
import Type from 'typebox'
import { DATA_DIR, VOCABULARY_PATH, type PlannerData } from './cases'
import { casesSchema, parseReferences, parseVocabulary, schemaProblems, type CaseSpec, type References } from './schema'

export const SPREADSHEET_DRAFT_DIR = `${DATA_DIR}spreadsheet-draft/`
export const SPREADSHEET_DRAFT_CASES_PATH = `${SPREADSHEET_DRAFT_DIR}cases.draft.json`
export const SPREADSHEET_DRAFT_REFERENCES_PATH = `${SPREADSHEET_DRAFT_DIR}references.draft.json`
export const SPREADSHEET_DRAFT_ATTACHMENTS_DIR = `${SPREADSHEET_DRAFT_DIR}attachments`
export const SPREADSHEET_DRAFT_SIZE = 3

export const spreadsheetDraftSchema = Type.Object(
  {
    status: Type.Literal('DRAFT'),
    notice: Type.String({ pattern: '^DRAFT: not approved\\.' }),
    cases: casesSchema,
  },
  { additionalProperties: false },
)

export interface SpreadsheetDraftFile {
  status: 'DRAFT'
  notice: string
  cases: CaseSpec[]
}

export interface SpreadsheetDraft extends SpreadsheetDraftFile {
  references: References
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function parseSpreadsheetDraft(input: unknown): SpreadsheetDraftFile {
  const problems = schemaProblems(spreadsheetDraftSchema, input)
  if (problems.length > 0) throw new Error(`invalid spreadsheet draft:\n${problems.join('\n')}`)
  return input as SpreadsheetDraftFile
}

export function loadSpreadsheetDraft(): SpreadsheetDraft {
  return { ...parseSpreadsheetDraft(readJson(SPREADSHEET_DRAFT_CASES_PATH)), references: parseReferences(readJson(SPREADSHEET_DRAFT_REFERENCES_PATH)) }
}

export function spreadsheetDraftData(): PlannerData {
  const draft = loadSpreadsheetDraft()
  return { cases: draft.cases, references: draft.references, vocabulary: parseVocabulary(readJson(VOCABULARY_PATH)) }
}
