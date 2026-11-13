import Type from 'typebox'

export const AGENT_DEFAULT_ID = 'default'
export const AGENT_MAX_ITEMS = 12
export const AGENT_NAME_MAX_CHARS = 60
export const AGENT_DESCRIPTION_MAX_CHARS = 200
export const AGENT_PERSONA_MAX_CHARS = 600
export const AGENT_INSTRUCTIONS_MAX_CHARS = 3000
export const AGENT_NAME_MAX_INPUT_CHARS = 4 * AGENT_NAME_MAX_CHARS
export const AGENT_DESCRIPTION_MAX_INPUT_CHARS = 4 * AGENT_DESCRIPTION_MAX_CHARS
export const AGENT_PERSONA_MAX_INPUT_CHARS = 4 * AGENT_PERSONA_MAX_CHARS
export const AGENT_INSTRUCTIONS_MAX_INPUT_CHARS = 4 * AGENT_INSTRUCTIONS_MAX_CHARS
export const AGENT_MAX_SKILLS = 8
export const AGENT_SKILLS_MAX_CHARS = 6000
export const AGENT_SKILL_IDS_MAX_INPUT = 4 * AGENT_MAX_SKILLS
export const AGENT_KINDS = ['assistant', 'reviewer'] as const

const AgentIdSchema = Type.String({ minLength: 1, maxLength: 128 })

export const AgentKindSchema = Type.Union([Type.Literal('assistant'), Type.Literal('reviewer')])

export const AgentSchema = Type.Object(
  {
    id: AgentIdSchema,
    name: Type.String({ minLength: 1, maxLength: AGENT_NAME_MAX_CHARS }),
    description: Type.String({ maxLength: AGENT_DESCRIPTION_MAX_CHARS }),
    persona: Type.String({ maxLength: AGENT_PERSONA_MAX_CHARS }),
    instructions: Type.String({ maxLength: AGENT_INSTRUCTIONS_MAX_CHARS }),
    kind: Type.Optional(AgentKindSchema),
    skillIds: Type.Optional(Type.Array(AgentIdSchema, { maxItems: AGENT_MAX_SKILLS })),
    builtin: Type.Boolean(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
)

export type Agent = Type.Static<typeof AgentSchema>
export type AgentKind = (typeof AGENT_KINDS)[number]

export type AgentField = 'name' | 'description' | 'persona' | 'instructions'
export type AgentRule = 'empty' | 'control_character' | 'line_separator' | 'bidi_format' | 'format_character' | 'too_long'

export interface AgentFields {
  name: string
  description: string
  persona: string
  instructions: string
}

export interface AgentProblem {
  field: AgentField
  rule: AgentRule
}

export type AgentCheck = { ok: true; fields: AgentFields } | { ok: false; problems: AgentProblem[] }
export type AgentFieldCheck = { ok: true; value: string } | { ok: false; rule: AgentRule }

export const AGENT_FIELDS: readonly AgentField[] = ['name', 'description', 'persona', 'instructions']
export const AGENT_RULES: readonly AgentRule[] = ['empty', 'control_character', 'line_separator', 'bidi_format', 'format_character', 'too_long']

export const AGENT_FIELD_LIMITS: Readonly<Record<AgentField, number>> = {
  name: AGENT_NAME_MAX_CHARS,
  description: AGENT_DESCRIPTION_MAX_CHARS,
  persona: AGENT_PERSONA_MAX_CHARS,
  instructions: AGENT_INSTRUCTIONS_MAX_CHARS,
}

export type TextField = AgentField | 'body'

const MULTI_LINE: ReadonlySet<TextField> = new Set<TextField>(['persona', 'instructions', 'body'])
const REQUIRED: ReadonlySet<TextField> = new Set<TextField>(['name', 'body'])

export function isMultiLineAgentField(field: AgentField): boolean {
  return MULTI_LINE.has(field)
}

const CONTROL = /\p{Cc}/u
const CONTROL_EXCEPT_LINE_FEED = /[^\P{Cc}\n]/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const FORMAT = /(?![\u200c\u200d])\p{Cf}|[\u{e0100}-\u{e01ef}]|\p{Cs}/u
const SPACES = /\s+/gu
const SEEN = /[^\p{Default_Ignorable_Code_Point}\p{M}\p{Z}\u2800]/u
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

export function normaliseTextField(field: TextField, raw: string, limit: number): AgentFieldCheck {
  const multiLine = MULTI_LINE.has(field)
  const required = REQUIRED.has(field)
  const trimmed = raw.normalize('NFC').trim()
  if (required && trimmed === '') return { ok: false, rule: 'empty' }
  if ((multiLine ? CONTROL_EXCEPT_LINE_FEED : CONTROL).test(trimmed)) return { ok: false, rule: 'control_character' }
  if (SEPARATOR.test(trimmed)) return { ok: false, rule: 'line_separator' }
  if (BIDI.test(trimmed)) return { ok: false, rule: 'bidi_format' }
  if (FORMAT.test(trimmed)) return { ok: false, rule: 'format_character' }
  if (required && !SEEN.test(trimmed)) return { ok: false, rule: 'empty' }
  const value = multiLine ? trimmed : trimmed.replace(SPACES, ' ')
  if ([...value].length > limit) return { ok: false, rule: 'too_long' }
  return { ok: true, value }
}

export function normaliseAgentField(field: AgentField, raw: string): AgentFieldCheck {
  return normaliseTextField(field, raw, AGENT_FIELD_LIMITS[field])
}

export function normaliseAgentFields(input: AgentFields): AgentCheck {
  const problems: AgentProblem[] = []
  const values: Record<AgentField, string> = { name: '', description: '', persona: '', instructions: '' }
  for (const field of AGENT_FIELDS) {
    const checked = normaliseAgentField(field, input[field])
    if (checked.ok) values[field] = checked.value
    else problems.push({ field, rule: checked.rule })
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, fields: values }
}

const NOUN: Readonly<Record<AgentField, string>> = {
  name: 'the name is',
  description: 'the description is',
  persona: 'the persona is',
  instructions: 'the instructions are',
}

const SUBJECT: Readonly<Record<AgentField, string>> = {
  name: 'the name has',
  description: 'the description has',
  persona: 'the persona has',
  instructions: 'the instructions have',
}

function ruleSentence(problem: AgentProblem): string {
  const { field, rule } = problem
  switch (rule) {
    case 'empty':
      return `${NOUN[field]} required`
    case 'too_long':
      return `${NOUN[field]} at most ${AGENT_FIELD_LIMITS[field]} characters`
    case 'control_character':
      return MULTI_LINE.has(field) ? `${SUBJECT[field]} no control characters except line breaks` : `${NOUN[field]} one line without control characters`
    case 'line_separator':
      return `${SUBJECT[field]} no line or paragraph separators`
    case 'bidi_format':
      return `${SUBJECT[field]} no bidirectional formatting characters`
    case 'format_character':
      return `${SUBJECT[field]} no invisible format characters`
  }
}

export function agentProblemLine(problem: AgentProblem): string {
  return `${problem.field}.${problem.rule}: ${ruleSentence(problem)}`
}

const PROBLEM_LINE = /^([a-z]+)\.([a-z_]+): \S.*$/s

export function parseAgentProblemLine(line: string): AgentProblem | undefined {
  const match = PROBLEM_LINE.exec(line)
  if (match === null) return undefined
  const field = AGENT_FIELDS.find((candidate) => candidate === match[1])
  const rule = AGENT_RULES.find((candidate) => candidate === match[2])
  return field === undefined || rule === undefined ? undefined : { field, rule }
}

export function agentNameKey(name: string): string {
  return name.normalize('NFC').replace(IGNORABLE, '').toUpperCase().toLowerCase().normalize('NFC')
}

export const AGENT_BUILTIN_NAMES: readonly string[] = ['Default', '기본']

export function isReservedAgentName(name: string): boolean {
  const key = agentNameKey(name.trim())
  return AGENT_BUILTIN_NAMES.some((builtin) => agentNameKey(builtin) === key)
}

export const AGENT_SKILL_RULES = ['unknown', 'duplicate', 'too_many', 'too_large'] as const
export type AgentSkillRule = (typeof AGENT_SKILL_RULES)[number]

export function checkAgentSkillIds(ids: readonly string[]): AgentSkillRule[] {
  const problems: AgentSkillRule[] = []
  if (new Set(ids).size < ids.length) problems.push('duplicate')
  if (ids.length > AGENT_MAX_SKILLS) problems.push('too_many')
  return problems
}

const SKILL_RULE_SENTENCE: Readonly<Record<AgentSkillRule, string>> = {
  unknown: 'a skill of the agent does not exist',
  duplicate: 'a skill is listed twice',
  too_many: `an agent has at most ${AGENT_MAX_SKILLS} skills`,
  too_large: `the skills of an agent are at most ${AGENT_SKILLS_MAX_CHARS} characters together`,
}

export function agentSkillProblemLine(rule: AgentSkillRule): string {
  return `skills.${rule}: ${SKILL_RULE_SENTENCE[rule]}`
}

const SKILL_PROBLEM_LINE = /^skills\.([a-z_]+): \S.*$/s

export function parseAgentSkillProblemLine(line: string): AgentSkillRule | undefined {
  const match = SKILL_PROBLEM_LINE.exec(line)
  return match === null ? undefined : AGENT_SKILL_RULES.find((rule) => rule === match[1])
}
