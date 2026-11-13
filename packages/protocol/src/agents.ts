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

const AgentIdSchema = Type.String({ minLength: 1, maxLength: 128 })

export const AgentSchema = Type.Object(
  {
    id: AgentIdSchema,
    name: Type.String({ minLength: 1, maxLength: AGENT_NAME_MAX_CHARS }),
    description: Type.String({ maxLength: AGENT_DESCRIPTION_MAX_CHARS }),
    persona: Type.String({ maxLength: AGENT_PERSONA_MAX_CHARS }),
    instructions: Type.String({ maxLength: AGENT_INSTRUCTIONS_MAX_CHARS }),
    builtin: Type.Boolean(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
)

export type Agent = Type.Static<typeof AgentSchema>

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

const MULTI_LINE: ReadonlySet<AgentField> = new Set<AgentField>(['persona', 'instructions'])

export function isMultiLineAgentField(field: AgentField): boolean {
  return MULTI_LINE.has(field)
}

const CONTROL = /\p{Cc}/u
const CONTROL_EXCEPT_LINE_FEED = /[^\P{Cc}\n]/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u
const FORMAT = /(?![‌‍])\p{Cf}|[\u{e0100}-\u{e01ef}]|\p{Cs}/u
const SPACES = /\s+/gu

export function normaliseAgentField(field: AgentField, raw: string): AgentFieldCheck {
  const multiLine = MULTI_LINE.has(field)
  const trimmed = raw.normalize('NFC').trim()
  if (field === 'name' && trimmed === '') return { ok: false, rule: 'empty' }
  if ((multiLine ? CONTROL_EXCEPT_LINE_FEED : CONTROL).test(trimmed)) return { ok: false, rule: 'control_character' }
  if (SEPARATOR.test(trimmed)) return { ok: false, rule: 'line_separator' }
  if (BIDI.test(trimmed)) return { ok: false, rule: 'bidi_format' }
  if (FORMAT.test(trimmed)) return { ok: false, rule: 'format_character' }
  const value = multiLine ? trimmed : trimmed.replace(SPACES, ' ')
  if ([...value].length > AGENT_FIELD_LIMITS[field]) return { ok: false, rule: 'too_long' }
  return { ok: true, value }
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
  return name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}
