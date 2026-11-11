import type { PlanIssue } from '@rill/dsl'
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
    const isFlagged = flagged(issue.pointer)
    if (isFlagged || roleField(issue.pointer)) {
      const trusted = TRUSTED_HINTS[issue.code]
      const keep = !isFlagged && issue.hint !== undefined && trusted?.some((format) => format.test(issue.hint as string)) === true
      return keep ? { ...generic(issue), hint: issue.hint as string } : generic(issue)
    }
    if (sensitive(issue.message) || (issue.hint !== undefined && sensitive(issue.hint))) return generic(issue)
    return { ...issue }
  })
}
