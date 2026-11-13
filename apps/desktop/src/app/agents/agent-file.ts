import { normaliseAgentFields, type AgentField, type AgentFields, type AgentRule } from '@rill/protocol'

export const AGENT_FILE_MAX_BYTES = 64 * 1024

export type FileProblemCode =
  | 'too_large'
  | 'not_utf8'
  | 'front_matter_missing'
  | 'front_matter_unclosed'
  | 'front_matter_line'
  | 'unknown_key'
  | 'duplicate_key'
  | 'heading_missing'
  | 'heading_duplicate'
  | 'heading_order'
  | 'unknown_heading'
  | 'text_before_heading'
  | 'reserved_text'

export type FileProblem = { kind: 'file'; code: FileProblemCode; line?: number } | { kind: 'field'; field: AgentField; rule: AgentRule }

export interface ParsedAgentFile {
  fields: AgentFields | undefined
  problems: FileProblem[]
}

export type SerialisedAgentFile = { ok: true; text: string } | { ok: false; reason: 'heading_in_text' }

const FENCE = '---'
const PERSONA = '# Persona'
const INSTRUCTIONS = '# Instructions'
const HEADING_LIKE = /^(?:# .*|#)$/
const KEY_LINE = /^([A-Za-z_]+):(?: (.*))?$/
const RESERVED = /agent-profile-/i

function fileProblem(code: FileProblemCode, line?: number): FileProblem {
  return line === undefined ? { kind: 'file', code } : { kind: 'file', code, line }
}

function trimBlankLines(lines: readonly string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start += 1
  while (end > start && lines[end - 1]!.trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

export function serialiseAgentFile(fields: AgentFields): SerialisedAgentFile {
  const reserved = [fields.persona, fields.instructions].some((text) => text.split('\n').some((line) => HEADING_LIKE.test(line)))
  if (reserved) return { ok: false, reason: 'heading_in_text' }
  const description = fields.description === '' ? 'description:' : `description: ${fields.description}`
  const section = (heading: string, body: string): string[] => [heading, '', ...(body === '' ? [] : [body, ''])]
  const text = [FENCE, `name: ${fields.name}`, description, FENCE, '', ...section(PERSONA, fields.persona), ...section(INSTRUCTIONS, fields.instructions)].join('\n')
  return { ok: true, text }
}

export function parseAgentFile(input: string): ParsedAgentFile {
  if (new TextEncoder().encode(input).length > AGENT_FILE_MAX_BYTES) return { fields: undefined, problems: [fileProblem('too_large')] }
  if (input.includes('�')) return { fields: undefined, problems: [fileProblem('not_utf8')] }
  const lines = (input.startsWith('﻿') ? input.slice(1) : input).replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== FENCE) return { fields: undefined, problems: [fileProblem('front_matter_missing')] }
  const close = lines.indexOf(FENCE, 1)
  if (close < 0) return { fields: undefined, problems: [fileProblem('front_matter_unclosed')] }

  const problems: FileProblem[] = []
  const values: Record<'name' | 'description', string | undefined> = { name: undefined, description: undefined }
  for (let index = 1; index < close; index++) {
    const match = KEY_LINE.exec(lines[index]!)
    if (match === null) {
      problems.push(fileProblem('front_matter_line', index + 1))
      continue
    }
    const key = match[1]!
    if (key !== 'name' && key !== 'description') {
      problems.push(fileProblem('unknown_key', index + 1))
      continue
    }
    if (values[key] !== undefined) {
      problems.push(fileProblem('duplicate_key', index + 1))
      continue
    }
    values[key] = match[2] ?? ''
  }

  const personaAt: number[] = []
  const instructionsAt: number[] = []
  const headings: number[] = []
  for (let index = close + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!HEADING_LIKE.test(line)) continue
    if (line === PERSONA) personaAt.push(index)
    else if (line === INSTRUCTIONS) instructionsAt.push(index)
    else problems.push(fileProblem('unknown_heading', index + 1))
    headings.push(index)
  }
  const first = headings[0]
  if (first !== undefined && lines.slice(close + 1, first).some((line) => line.trim() !== '')) problems.push(fileProblem('text_before_heading'))
  if (first === undefined && lines.slice(close + 1).some((line) => line.trim() !== '')) problems.push(fileProblem('text_before_heading'))
  if (personaAt.length === 0 || instructionsAt.length === 0) problems.push(fileProblem('heading_missing'))
  if (personaAt.length > 1 || instructionsAt.length > 1) problems.push(fileProblem('heading_duplicate'))
  if (personaAt.length > 0 && instructionsAt.length > 0 && personaAt[0]! > instructionsAt[0]!) problems.push(fileProblem('heading_order'))

  const section = (at: readonly number[]): string => {
    const start = at[0]
    if (start === undefined) return ''
    const end = headings.find((heading) => heading > start) ?? lines.length
    return trimBlankLines(lines.slice(start + 1, end))
  }
  const raw: AgentFields = { name: values.name ?? '', description: values.description ?? '', persona: section(personaAt), instructions: section(instructionsAt) }
  if (RESERVED.test(raw.persona) || RESERVED.test(raw.instructions)) problems.push(fileProblem('reserved_text'))
  const checked = normaliseAgentFields(raw)
  if (!checked.ok) problems.push(...checked.problems.map((problem): FileProblem => ({ kind: 'field', field: problem.field, rule: problem.rule })))
  return { fields: problems.length === 0 && checked.ok ? checked.fields : raw, problems }
}

export function problemFields(problems: readonly FileProblem[]): ReadonlySet<AgentField> {
  return new Set(problems.flatMap((problem) => (problem.kind === 'field' ? [problem.field] : [])))
}

