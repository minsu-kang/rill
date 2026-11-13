import { readFileSync } from 'node:fs'
import Type from 'typebox'
import { DATA_DIR, VOCABULARY_PATH, type PlannerData } from './cases'
import { casesSchema, parseReferences, parseVocabulary, schemaProblems, type CaseSpec, type References } from './schema'

export const SLACK_DRAFT_DIR = `${DATA_DIR}slack-draft/`
export const SLACK_DRAFT_CASES_PATH = `${SLACK_DRAFT_DIR}cases.draft.json`
export const SLACK_DRAFT_REFERENCES_PATH = `${SLACK_DRAFT_DIR}references.draft.json`
export const SLACK_DRAFT_ATTACHMENTS_DIR = `${SLACK_DRAFT_DIR}attachments`
export const SLACK_DRAFT_SIZE = 3

export const slackDraftSchema = Type.Object(
  {
    status: Type.Literal('DRAFT'),
    notice: Type.String({ pattern: '^DRAFT: not approved\\.' }),
    cases: casesSchema,
  },
  { additionalProperties: false },
)

export interface SlackDraftFile {
  status: 'DRAFT'
  notice: string
  cases: CaseSpec[]
}

export interface SlackDraft extends SlackDraftFile {
  references: References
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function parseSlackDraft(input: unknown): SlackDraftFile {
  const problems = schemaProblems(slackDraftSchema, input)
  if (problems.length > 0) throw new Error(`invalid Slack draft:\n${problems.join('\n')}`)
  return input as SlackDraftFile
}

export function loadSlackDraft(): SlackDraft {
  return { ...parseSlackDraft(readJson(SLACK_DRAFT_CASES_PATH)), references: parseReferences(readJson(SLACK_DRAFT_REFERENCES_PATH)) }
}

export function slackDraftData(): PlannerData {
  const draft = loadSlackDraft()
  return { cases: draft.cases, references: draft.references, vocabulary: parseVocabulary(readJson(VOCABULARY_PATH)) }
}
