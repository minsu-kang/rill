import type { JsonSchema } from '@rill/llm'
import { MAX_EXPLANATION_CHARS, MAX_REQUEST_CHARS, cleanText } from './scrub'
import { LIKELY_CAUSES, SUGGESTED_ACTIONS, type ExplainAnswer } from './types'

const MAX_ACTIONS = 3
const MAX_NODE_ID_CHARS = 64
const ROOT_KEYS: ReadonlySet<string> = new Set(['explanation', 'likelyCause', 'suggestedActions', 'fixProposal'])
const PROPOSAL_KEYS: ReadonlySet<string> = new Set(['nodeId', 'requestText'])

export const ANSWER_PROBLEMS = {
  notObject: 'the answer must be one JSON object that matches the output schema',
  unknownKey: 'the answer has a key that the output schema does not list',
  explanation: `explanation must be a string of 1 to ${MAX_EXPLANATION_CHARS} characters`,
  likelyCause: `likelyCause must be one of: ${LIKELY_CAUSES.join(', ')}`,
  suggestedActions: `suggestedActions must be a list of at most ${MAX_ACTIONS} distinct words from: ${SUGGESTED_ACTIONS.join(', ')}`,
  fixProposal: 'fixProposal must be left out, or be an object with nodeId and requestText',
  proposalKey: 'fixProposal has a key that the output schema does not list',
  proposalNode: 'fixProposal.nodeId must be the id of one node',
  proposalText: `fixProposal.requestText must be a string of 1 to ${MAX_REQUEST_CHARS} characters`,
} as const

export interface CheckedAnswer {
  answer?: ExplainAnswer
  problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length > limit * 2) return undefined
  const text = cleanText(value).trim()
  const length = [...text].length
  return length >= 1 && length <= limit ? text : undefined
}

function actionsOf(value: unknown): ExplainAnswer['suggestedActions'] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) return undefined
  const known: readonly unknown[] = SUGGESTED_ACTIONS
  if (!value.every((item) => known.includes(item)) || new Set(value).size !== value.length) return undefined
  return [...value] as ExplainAnswer['suggestedActions']
}

function proposalOf(value: unknown, problems: Set<string>): ExplainAnswer['fixProposal'] {
  if (!isRecord(value)) {
    problems.add(ANSWER_PROBLEMS.fixProposal)
    return undefined
  }
  if (Object.keys(value).some((key) => !PROPOSAL_KEYS.has(key))) problems.add(ANSWER_PROBLEMS.proposalKey)
  const nodeId = value['nodeId']
  const nodeOk = typeof nodeId === 'string' && nodeId !== '' && nodeId.length <= MAX_NODE_ID_CHARS
  if (!nodeOk) problems.add(ANSWER_PROBLEMS.proposalNode)
  const requestText = textOf(value['requestText'], MAX_REQUEST_CHARS)
  if (requestText === undefined) problems.add(ANSWER_PROBLEMS.proposalText)
  return nodeOk && requestText !== undefined ? { nodeId, requestText } : undefined
}

export function checkAnswer(data: unknown): CheckedAnswer {
  if (!isRecord(data)) return { problems: [ANSWER_PROBLEMS.notObject] }
  const problems = new Set<string>()
  if (Object.keys(data).some((key) => !ROOT_KEYS.has(key))) problems.add(ANSWER_PROBLEMS.unknownKey)
  const explanation = textOf(data['explanation'], MAX_EXPLANATION_CHARS)
  if (explanation === undefined) problems.add(ANSWER_PROBLEMS.explanation)
  const cause = (LIKELY_CAUSES as readonly unknown[]).includes(data['likelyCause']) ? (data['likelyCause'] as ExplainAnswer['likelyCause']) : undefined
  if (cause === undefined) problems.add(ANSWER_PROBLEMS.likelyCause)
  const actions = actionsOf(data['suggestedActions'])
  if (actions === undefined) problems.add(ANSWER_PROBLEMS.suggestedActions)
  const raw = data['fixProposal']
  const fixProposal = raw === undefined || raw === null ? undefined : proposalOf(raw, problems)
  if (problems.size > 0 || explanation === undefined || cause === undefined || actions === undefined) return { problems: [...problems] }
  return { answer: { explanation, likelyCause: cause, suggestedActions: actions, ...(fixProposal === undefined ? {} : { fixProposal }) }, problems: [] }
}

export function explainSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      explanation: {
        type: 'string',
        description: `Plain text for a person who does not program, 1 to ${MAX_EXPLANATION_CHARS} characters: what failed, the most likely reason and what to do next. No markup and no links.`,
      },
      likelyCause: { type: 'string', enum: [...LIKELY_CAUSES], description: 'The most likely kind of cause.' },
      suggestedActions: {
        type: 'array',
        items: { type: 'string', enum: [...SUGGESTED_ACTIONS] },
        description: `At most ${MAX_ACTIONS} distinct actions the person may take. The app turns each into a button; use none when no action helps.`,
      },
      fixProposal: {
        type: 'object',
        description: 'Only when the configuration of one node can be changed to fix the failure.',
        properties: {
          nodeId: { type: 'string', description: 'The id of the node to change.' },
          requestText: {
            type: 'string',
            description: `What to change, in words, at most ${MAX_REQUEST_CHARS} characters. Name no address, URL, path or recipient that the workflow does not already contain.`,
          },
        },
        required: ['nodeId', 'requestText'],
        additionalProperties: false,
      },
    },
    required: ['explanation', 'likelyCause', 'suggestedActions'],
    additionalProperties: false,
  }
}
