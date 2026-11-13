import { normaliseSkillFields, type AgentRule, type SkillField, type SkillFields } from '@rill/protocol'

export const SKILL_FILE_MAX_BYTES = 64 * 1024

export type SkillFileProblemCode =
  | 'too_large'
  | 'not_utf8'
  | 'front_matter_missing'
  | 'front_matter_unclosed'
  | 'front_matter_line'
  | 'unknown_key'
  | 'duplicate_key'
  | 'heading_missing'
  | 'heading_duplicate'
  | 'unknown_heading'
  | 'text_before_heading'
  | 'reserved_text'

export type SkillFileProblem = { kind: 'file'; code: SkillFileProblemCode; line?: number } | { kind: 'field'; field: SkillField; rule: AgentRule }

export interface ParsedSkillFile {
  fields: SkillFields | undefined
  problems: SkillFileProblem[]
}

export type SerialisedSkillFile = { ok: true; text: string } | { ok: false; reason: 'heading_in_text' }

const FENCE = '---'
const BODY = '# Body'
const HEADING_LIKE = /^(?:# .*|#)$/
const KEY_LINE = /^([A-Za-z_]+):(?: (.*))?$/
const RESERVED = /agent-profile-/i

function fileProblem(code: SkillFileProblemCode, line?: number): SkillFileProblem {
  return line === undefined ? { kind: 'file', code } : { kind: 'file', code, line }
}

function trimBlankLines(lines: readonly string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start += 1
  while (end > start && lines[end - 1]!.trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

export function serialiseSkillFile(fields: SkillFields): SerialisedSkillFile {
  if (fields.body.split('\n').some((line) => HEADING_LIKE.test(line))) return { ok: false, reason: 'heading_in_text' }
  const description = fields.description === '' ? 'description:' : `description: ${fields.description}`
  return { ok: true, text: [FENCE, `name: ${fields.name}`, description, FENCE, '', BODY, '', ...(fields.body === '' ? [] : [fields.body, ''])].join('\n') }
}

export function parseSkillFile(input: string): ParsedSkillFile {
  if (new TextEncoder().encode(input).length > SKILL_FILE_MAX_BYTES) return { fields: undefined, problems: [fileProblem('too_large')] }
  if (input.includes('\ufffd')) return { fields: undefined, problems: [fileProblem('not_utf8')] }
  const lines = (input.startsWith('\ufeff') ? input.slice(1) : input).replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== FENCE) return { fields: undefined, problems: [fileProblem('front_matter_missing')] }
  const close = lines.indexOf(FENCE, 1)
  if (close < 0) return { fields: undefined, problems: [fileProblem('front_matter_unclosed')] }

  const problems: SkillFileProblem[] = []
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

  const bodyAt: number[] = []
  const headings: number[] = []
  for (let index = close + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!HEADING_LIKE.test(line)) continue
    if (line === BODY) bodyAt.push(index)
    else problems.push(fileProblem('unknown_heading', index + 1))
    headings.push(index)
  }
  const first = headings[0]
  if (first !== undefined && lines.slice(close + 1, first).some((line) => line.trim() !== '')) problems.push(fileProblem('text_before_heading'))
  if (first === undefined && lines.slice(close + 1).some((line) => line.trim() !== '')) problems.push(fileProblem('text_before_heading'))
  if (bodyAt.length === 0) problems.push(fileProblem('heading_missing'))
  if (bodyAt.length > 1) problems.push(fileProblem('heading_duplicate'))

  const start = bodyAt[0]
  const end = start === undefined ? lines.length : (headings.find((heading) => heading > start) ?? lines.length)
  const raw: SkillFields = { name: values.name ?? '', description: values.description ?? '', body: start === undefined ? '' : trimBlankLines(lines.slice(start + 1, end)) }
  if (RESERVED.test(raw.body)) problems.push(fileProblem('reserved_text'))
  const checked = normaliseSkillFields(raw)
  if (!checked.ok) problems.push(...checked.problems.flatMap((problem): SkillFileProblem[] => (problem.rule === 'too_large_for_agent' ? [] : [{ kind: 'field', field: problem.field, rule: problem.rule }])))
  return { fields: problems.length === 0 && checked.ok ? checked.fields : raw, problems }
}
