import Type from 'typebox'
import { AGENT_SKILLS_MAX_CHARS, agentNameKey, normaliseTextField, type AgentRule } from './agents'

export const SKILL_MAX_ITEMS = 24
export const SKILL_NAME_MAX_CHARS = 60
export const SKILL_DESCRIPTION_MAX_CHARS = 200
export const SKILL_BODY_MAX_CHARS = 4000
export const SKILL_NAME_MAX_INPUT_CHARS = 4 * SKILL_NAME_MAX_CHARS
export const SKILL_DESCRIPTION_MAX_INPUT_CHARS = 4 * SKILL_DESCRIPTION_MAX_CHARS
export const SKILL_BODY_MAX_INPUT_CHARS = 4 * SKILL_BODY_MAX_CHARS

export const SkillSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: SKILL_NAME_MAX_CHARS }),
    description: Type.String({ maxLength: SKILL_DESCRIPTION_MAX_CHARS }),
    body: Type.String({ minLength: 1, maxLength: SKILL_BODY_MAX_CHARS }),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
)

export type Skill = Type.Static<typeof SkillSchema>

export type SkillField = 'name' | 'description' | 'body'
export type SkillRule = AgentRule | 'too_large_for_agent'

export interface SkillFields {
  name: string
  description: string
  body: string
}

export interface SkillProblem {
  field: SkillField
  rule: SkillRule
  agents?: number
}

export type SkillCheck = { ok: true; fields: SkillFields } | { ok: false; problems: SkillProblem[] }

export const SKILL_FIELDS: readonly SkillField[] = ['name', 'description', 'body']
export const SKILL_RULES: readonly AgentRule[] = ['empty', 'control_character', 'line_separator', 'bidi_format', 'format_character', 'too_long']

export const SKILL_FIELD_LIMITS: Readonly<Record<SkillField, number>> = {
  name: SKILL_NAME_MAX_CHARS,
  description: SKILL_DESCRIPTION_MAX_CHARS,
  body: SKILL_BODY_MAX_CHARS,
}

export function normaliseSkillFields(input: SkillFields): SkillCheck {
  const problems: SkillProblem[] = []
  const values: SkillFields = { name: '', description: '', body: '' }
  for (const field of SKILL_FIELDS) {
    const checked = normaliseTextField(field, input[field], SKILL_FIELD_LIMITS[field])
    if (checked.ok) values[field] = checked.value
    else problems.push({ field, rule: checked.rule })
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, fields: values }
}

const NOUN: Readonly<Record<SkillField, string>> = {
  name: 'the name is',
  description: 'the description is',
  body: 'the body is',
}

const SUBJECT: Readonly<Record<SkillField, string>> = {
  name: 'the name has',
  description: 'the description has',
  body: 'the body has',
}

function ruleSentence(problem: SkillProblem): string {
  const { field, rule } = problem
  switch (rule) {
    case 'empty':
      return `${NOUN[field]} required`
    case 'too_long':
      return `${NOUN[field]} at most ${SKILL_FIELD_LIMITS[field]} characters`
    case 'control_character':
      return field === 'body' ? `${SUBJECT[field]} no control characters except line breaks` : `${NOUN[field]} one line without control characters`
    case 'line_separator':
      return `${SUBJECT[field]} no line or paragraph separators`
    case 'bidi_format':
      return `${SUBJECT[field]} no bidirectional formatting characters`
    case 'format_character':
      return `${SUBJECT[field]} no invisible format characters`
    case 'too_large_for_agent': {
      const count = problem.agents ?? 1
      return `the body would make the skills of ${count} ${count === 1 ? 'agent' : 'agents'} longer than ${AGENT_SKILLS_MAX_CHARS} characters together`
    }
  }
}

export function skillProblemLine(problem: SkillProblem): string {
  return `${problem.field}.${problem.rule}: ${ruleSentence(problem)}`
}

const PROBLEM_LINE = /^([a-z]+)\.([a-z_]+): \S.*$/s
const AGENT_COUNT = /^the body would make the skills of (\d+) agents? longer than /

export function parseSkillProblemLine(line: string): SkillProblem | undefined {
  const match = PROBLEM_LINE.exec(line)
  if (match === null) return undefined
  const field = SKILL_FIELDS.find((candidate) => candidate === match[1])
  if (field === undefined) return undefined
  if (match[2] === 'too_large_for_agent') {
    const count = AGENT_COUNT.exec(line.slice(line.indexOf(': ') + 2))
    return field === 'body' && count !== null ? { field, rule: 'too_large_for_agent', agents: Number(count[1]) } : undefined
  }
  const rule = SKILL_RULES.find((candidate) => candidate === match[2])
  return rule === undefined ? undefined : { field, rule }
}

export const skillNameKey = agentNameKey
