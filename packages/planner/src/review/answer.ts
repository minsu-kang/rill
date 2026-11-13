import type { JsonSchema } from '@rill/llm'
import { cleanText } from '../explain/scrub'
import { REVIEW_SEVERITIES, type ReviewAnswer, type ReviewFinding } from './types'

export const MAX_REVIEW_TEXT_CHARS = 400
export const MAX_REVIEW_FINDINGS = 10
const MAX_NODE_ID_CHARS = 64
const ROOT_KEYS: ReadonlySet<string> = new Set(['summary', 'findings'])
const FINDING_KEYS: ReadonlySet<string> = new Set(['severity', 'text', 'nodeId'])

export const REVIEW_ANSWER_PROBLEMS = {
  notObject: 'the answer must be one JSON object that matches the output schema',
  unknownKey: 'the answer has a key that the output schema does not list',
  summary: `summary must be a string of 1 to ${MAX_REVIEW_TEXT_CHARS} characters`,
  findings: `findings must be a list of at most ${MAX_REVIEW_FINDINGS} objects`,
  findingKey: 'a finding has a key that the output schema does not list',
  severity: `severity of a finding must be one of: ${REVIEW_SEVERITIES.join(', ')}`,
  text: `text of a finding must be a string of 1 to ${MAX_REVIEW_TEXT_CHARS} characters`,
  nodeId: 'nodeId of a finding must be left out, or be the id of one node',
} as const

export interface CheckedReview {
  answer?: ReviewAnswer
  problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_REVIEW_TEXT_CHARS * 2) return undefined
  const text = cleanText(value).trim()
  const length = [...text].length
  return length >= 1 && length <= MAX_REVIEW_TEXT_CHARS ? text : undefined
}

function findingOf(value: unknown, problems: Set<string>): ReviewFinding | undefined {
  if (!isRecord(value)) {
    problems.add(REVIEW_ANSWER_PROBLEMS.findings)
    return undefined
  }
  if (Object.keys(value).some((key) => !FINDING_KEYS.has(key))) problems.add(REVIEW_ANSWER_PROBLEMS.findingKey)
  const severity = (REVIEW_SEVERITIES as readonly unknown[]).includes(value['severity']) ? (value['severity'] as ReviewFinding['severity']) : undefined
  if (severity === undefined) problems.add(REVIEW_ANSWER_PROBLEMS.severity)
  const text = textOf(value['text'])
  if (text === undefined) problems.add(REVIEW_ANSWER_PROBLEMS.text)
  const raw = value['nodeId']
  const withoutNode = raw === undefined || raw === null
  const nodeOk = withoutNode || (typeof raw === 'string' && raw !== '' && raw.length <= MAX_NODE_ID_CHARS)
  if (!nodeOk) problems.add(REVIEW_ANSWER_PROBLEMS.nodeId)
  if (severity === undefined || text === undefined || !nodeOk) return undefined
  return { severity, text, ...(withoutNode ? {} : { nodeId: raw as string }) }
}

export function checkReview(data: unknown): CheckedReview {
  if (!isRecord(data)) return { problems: [REVIEW_ANSWER_PROBLEMS.notObject] }
  const problems = new Set<string>()
  if (Object.keys(data).some((key) => !ROOT_KEYS.has(key))) problems.add(REVIEW_ANSWER_PROBLEMS.unknownKey)
  const summary = textOf(data['summary'])
  if (summary === undefined) problems.add(REVIEW_ANSWER_PROBLEMS.summary)
  const raw = data['findings']
  const findings: ReviewFinding[] = []
  if (!Array.isArray(raw) || raw.length > MAX_REVIEW_FINDINGS) problems.add(REVIEW_ANSWER_PROBLEMS.findings)
  else {
    for (const entry of raw) {
      const finding = findingOf(entry, problems)
      if (finding !== undefined) findings.push(finding)
    }
  }
  if (problems.size > 0 || summary === undefined) return { problems: [...problems] }
  return { answer: { summary, findings }, problems: [] }
}

export function reviewSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: `Plain text, 1 to ${MAX_REVIEW_TEXT_CHARS} characters: your overall view of the workflow in one or two sentences. No markup and no links.`,
      },
      findings: {
        type: 'array',
        description: `At most ${MAX_REVIEW_FINDINGS} findings, the most important first. Use an empty list when there is nothing to say.`,
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: [...REVIEW_SEVERITIES], description: 'problem: it will probably not do what was asked or it is unsafe. warning: it may be a problem. info: a remark.' },
            text: { type: 'string', description: `Plain text, 1 to ${MAX_REVIEW_TEXT_CHARS} characters: what is wrong or worth knowing, and what to look at. No markup and no links.` },
            nodeId: { type: 'string', description: 'Only when the finding is about one node: the id of that node. Use only an id that exists in the workflow.' },
          },
          required: ['severity', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'findings'],
    additionalProperties: false,
  }
}
