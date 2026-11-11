import type { PlanIssue, Workflow } from '@rill/dsl'
import { fieldRoles, subschemaAt, type NodeDefinition } from '@rill/nodes-core'
import { HIDDEN_FIELDS } from '../hidden'
import type { RedactInput } from '../ports'
import { chosenNames, createNameGuard, outputFieldNames, wordsIn } from './names'
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

const HIDDEN_SEGMENT = '<hidden>'
const ADDITIONAL_PROPERTIES = /_additionalProperties$/

function generic(issue: PlanIssue, pointer = issue.pointer): PlanIssue {
  return { stage: issue.stage, pointer, code: issue.code, message: `${issue.code} at ${pointer}` }
}

function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

function configSite(pointer: string, input: RedactInput): { def: NodeDefinition; inside: string } | undefined {
  const match = NODE_CONFIG.exec(pointer)
  if (match === null || input.workflow === undefined) return undefined
  const node = input.workflow.nodes[Number(match[1])]
  const def = node === undefined ? undefined : input.registry.get(node.type)
  return def === undefined ? undefined : { def, inside: match[2] ?? '' }
}

function allowedProperties(issue: PlanIssue, input: RedactInput): string | undefined {
  if (!ADDITIONAL_PROPERTIES.test(issue.code)) return undefined
  const site = configSite(issue.pointer, input)
  if (site === undefined || site.inside === '') return undefined
  const parent = site.inside.slice(0, site.inside.lastIndexOf('/'))
  const properties = subschemaAt(site.def.configSchema as unknown as Record<string, unknown>, parent)?.properties
  if (properties === null || typeof properties !== 'object') return undefined
  const names = Object.keys(properties).filter((name) => parent !== '' || !(HIDDEN_FIELDS as readonly string[]).includes(name))
  return names.length > 0 ? `allowed properties: ${names.join(', ')}` : undefined
}

export function redactIssues(issues: PlanIssue[], input: RedactInput): PlanIssue[] {
  const haystacks = input.attachmentTexts.map(fold)
  const sensitive = (text: string): boolean =>
    looksExtracted(text) || literalsIn(text).some((literal) => haystacks.some((haystack) => haystack.includes(fold(literal))))
  const guard = createNameGuard({
    attachmentTexts: input.attachmentTexts,
    registry: input.registry,
    ...(input.userTexts === undefined ? {} : { userTexts: input.userTexts }),
    ...(input.existingWorkflow === undefined ? {} : { existingWorkflow: input.existingWorkflow }),
    ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
  })
  const chosen = new Set([...chosenNames(input.workflow, input.patch)].map(fold))
  const echoedName = (word: string): boolean => chosen.has(fold(word)) && guard.hides(word)
  const echoes = (text: string): boolean => wordsIn(text).some(echoedName)
  const hiddenSegment = (segment: string): boolean => sensitive(segment) || echoedName(segment)
  const hidePointer = (pointer: string): string =>
    pointer
      .split('/')
      .map((segment, index) => (index > 0 && hiddenSegment(decodeSegment(segment)) ? HIDDEN_SEGMENT : segment))
      .join('/')
  const flagged = (pointer: string): boolean => input.flags.some((flag) => isWithin(pointer, flag.pointer))
  const roleField = (pointer: string): boolean => {
    const site = configSite(pointer, input)
    return site !== undefined && fieldRoles(site.def).some((field) => isWithin(site.inside, field.pointer))
  }
  return issues.map((issue) => {
    const pointer = hidePointer(issue.pointer)
    const withHint = (out: PlanIssue, hint: string | undefined): PlanIssue => {
      const kept = hint ?? (pointer === issue.pointer ? undefined : allowedProperties(issue, input))
      return kept === undefined ? out : { ...out, hint: kept }
    }
    const trusted = issue.hint !== undefined && TRUSTED_HINTS[issue.code]?.some((format) => format.test(issue.hint as string)) === true
    if (flagged(issue.pointer) || roleField(issue.pointer)) return withHint(generic(issue, pointer), trusted ? issue.hint : undefined)
    const fieldHint = isFieldHint(issue, input.workflow, input.registry)
    const hintSensitive = issue.hint !== undefined && !fieldHint && sensitive(issue.hint)
    if (sensitive(issue.message) || hintSensitive) return withHint(generic(issue, pointer), fieldHint ? issue.hint : undefined)
    if (pointer !== issue.pointer || echoes(issue.message) || (issue.hint !== undefined && !fieldHint && echoes(issue.hint))) {
      const hint = issue.hint
      const clean = hint !== undefined && (fieldHint || !echoes(hint))
      return withHint(generic(issue, pointer), clean ? hint : undefined)
    }
    return { ...issue }
  })
}
