import type { PlanIssue, Workflow } from '@rill/dsl'
import { fieldRoles } from '@rill/nodes-core'
import type { RedactInput } from '../ports'
import { fold } from './normalize'

const MIN_LITERAL = 6

const TRUSTED_HINTS: Record<string, RegExp[]> = {
  unknown_connection: [/^configured: [^\n]*$/, /^no connections are configured$/],
  path_outside_roots: [/^allowed folders: [^\n]*$/],
  connection_kind_mismatch: [/^configured (slack|http|webhookSecret) connections: [^\n]*$/, /^no (slack|http|webhookSecret) connections are configured$/],
}

const NODE_CONFIG = /^\/nodes\/(\d+)\/config(\/.*)?$/
const QUOTED = /"([^"]+)"|'([^']+)'|`([^`]+)`/g
const SEPARATORS = /[\s"'`<>()[\]{},;|]+/
const VALUE_LIKE = /[0-9./:@~#%?=&_\\-]/
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/i
const EMAIL_LIKE = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i

function isWithin(pointer: string, base: string): boolean {
  return pointer === base || pointer.startsWith(`${base}/`)
}

export function literalsIn(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(QUOTED)) {
    const quoted = match[1] ?? match[2] ?? match[3]
    if (quoted !== undefined && quoted.length >= MIN_LITERAL) found.push(quoted)
  }
  for (const raw of text.split(SEPARATORS)) {
    const token = raw.replace(/^[.:!?]+|[.:!?]+$/g, '')
    if (token.length >= MIN_LITERAL && VALUE_LIKE.test(token)) found.push(token)
  }
  return found
}

export function containsAttachmentLiteral(text: string, attachmentTexts: readonly string[]): boolean {
  const haystacks = attachmentTexts.map(fold)
  return [text, ...literalsIn(text)].some((literal) => literal.length >= MIN_LITERAL && haystacks.some((haystack) => haystack.includes(fold(literal))))
}

const FIELD_HINT = /^available: ([^\n]+)$/

function collectKeys(schema: unknown, into: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectKeys(item, into)
    return
  }
  if (schema === null || typeof schema !== 'object') return
  const node = schema as Record<string, unknown>
  const properties = node.properties
  if (properties !== null && typeof properties === 'object') for (const key of Object.keys(properties)) into.add(key)
  for (const value of Object.values(node)) collectKeys(value, into)
}

function outputFieldNames(workflow: Workflow, registry: RedactInput['registry']): Set<string> {
  const names = new Set<string>()
  for (const node of workflow.nodes) {
    const def = registry.get(node.type)
    if (def === undefined) continue
    let schema: unknown = def.outputSchema
    if (def.kind === 'action' && def.outputSchemaFor !== undefined) {
      try {
        schema = def.outputSchemaFor(node.config)
      } catch {
        schema = def.outputSchema
      }
    }
    collectKeys(schema, names)
  }
  return names
}

function isFieldHint(issue: PlanIssue, workflow: Workflow | undefined, registry: RedactInput['registry']): boolean {
  if (issue.code !== 'unknown_output_field' || issue.hint === undefined || workflow === undefined || looksExtracted(issue.hint)) return false
  const match = FIELD_HINT.exec(issue.hint)
  if (match === null) return false
  const names = outputFieldNames(workflow, registry)
  return (match[1] as string).split(', ').every((name) => name !== '' && names.has(name))
}

function looksExtracted(text: string): boolean {
  return URL_LIKE.test(text) || EMAIL_LIKE.test(text)
}

function generic(issue: PlanIssue): PlanIssue {
  return { stage: issue.stage, pointer: issue.pointer, code: issue.code, message: `${issue.code} at ${issue.pointer}` }
}

export function redactIssues(issues: PlanIssue[], input: RedactInput): PlanIssue[] {
  const haystacks = input.attachmentTexts.map(fold)
  const sensitive = (text: string): boolean =>
    looksExtracted(text) || literalsIn(text).some((literal) => haystacks.some((haystack) => haystack.includes(fold(literal))))
  const flagged = (pointer: string): boolean => input.flags.some((flag) => isWithin(pointer, flag.pointer))
  const roleField = (pointer: string): boolean => {
    const match = NODE_CONFIG.exec(pointer)
    if (match === null || input.workflow === undefined) return false
    const node = input.workflow.nodes[Number(match[1])]
    const def = node === undefined ? undefined : input.registry.get(node.type)
    if (def === undefined) return false
    const inside = match[2] ?? ''
    return fieldRoles(def).some((field) => isWithin(inside, field.pointer))
  }
  return issues.map((issue) => {
    const trusted = issue.hint !== undefined && TRUSTED_HINTS[issue.code]?.some((format) => format.test(issue.hint as string)) === true
    if (flagged(issue.pointer) || roleField(issue.pointer)) return trusted ? { ...generic(issue), hint: issue.hint as string } : generic(issue)
    const fieldHint = isFieldHint(issue, input.workflow, input.registry)
    const hintSensitive = issue.hint !== undefined && !fieldHint && sensitive(issue.hint)
    if (sensitive(issue.message) || hintSensitive) return fieldHint ? { ...generic(issue), hint: issue.hint as string } : generic(issue)
    return { ...issue }
  })
}
