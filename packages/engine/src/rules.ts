import { domainToASCII } from 'node:url'
import type { PlanIssue } from '@rill/dsl'
import { PLAN_EFFORTS, RULE_MAX_INPUT_CHARS, RULE_MAX_ITEMS, type RuleKind } from '@rill/protocol'

export type RuleProblem =
  | 'empty'
  | 'control_character'
  | 'line_separator'
  | 'bidi_format'
  | 'format_character'
  | 'too_long'
  | 'unknown_node_type'
  | 'unknown_effort'
  | 'host_scheme'
  | 'host_path'
  | 'host_port'
  | 'host_user_info'
  | 'host_space'
  | 'host_empty_label'
  | 'host_wildcard'
  | 'host_characters'
  | 'host_label_length'
  | 'host_too_long'
  | 'host_idn'

const RULE_TEXT: Readonly<Record<RuleProblem, string>> = {
  empty: 'a rule value is not empty',
  control_character: 'a rule value is one line without control characters',
  line_separator: 'a rule value has no line or paragraph separators',
  bidi_format: 'a rule value has no bidirectional formatting characters',
  format_character: 'a rule value has no invisible format characters',
  too_long: `a rule value is at most ${RULE_MAX_INPUT_CHARS} characters`,
  unknown_node_type: 'a forbidden node is a node type of the catalog without its version, such as http.request',
  unknown_effort: `the planning effort cap is one of ${PLAN_EFFORTS.join(', ')}`,
  host_scheme: 'write only the host name, without http:// or https://',
  host_path: 'write only the host name, without a path, query or fragment',
  host_port: 'write only the host name, without a port',
  host_user_info: 'write only the host name, without user info',
  host_space: 'a host name has no spaces',
  host_empty_label: 'a host name has no empty part between dots, and does not start or end with a dot',
  host_wildcard: 'a wildcard is *. in front of a host name, such as *.example.com, and not in front of an address',
  host_characters: 'a host name has letters, digits, hyphens and dots; an address is written in full',
  host_label_length: 'each part of a host name is at most 63 characters',
  host_too_long: 'a host name is at most 253 characters',
  host_idn: 'the host name cannot be converted to its ASCII form',
}

export class RuleInvalidError extends Error {
  readonly rule: RuleProblem
  readonly problems: string[]

  constructor(rule: RuleProblem) {
    super(`the rule is not valid: ${rule}`)
    this.name = 'RuleInvalidError'
    this.rule = rule
    this.problems = [`${rule}: ${RULE_TEXT[rule]}`]
  }
}

export class RuleFullError extends Error {
  constructor() {
    super(`at most ${RULE_MAX_ITEMS} rules can be saved; delete one first`)
    this.name = 'RuleFullError'
  }
}

export class RuleDuplicateError extends Error {
  constructor() {
    super('the same rule is already saved')
    this.name = 'RuleDuplicateError'
  }
}

export class RuleNotFoundError extends Error {
  constructor() {
    super('rule not found')
    this.name = 'RuleNotFoundError'
  }
}

export const RULE_VIOLATION_MESSAGE = 'the workflow breaks a rule you set; remove the rule or change the workflow'

export class RuleViolationError extends Error {
  readonly issues: PlanIssue[]

  constructor(issues: PlanIssue[]) {
    super(RULE_VIOLATION_MESSAGE)
    this.name = 'RuleViolationError'
    this.issues = issues
  }
}

const CONTROL = /\p{Cc}/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u
const FORMAT = /(?![‌‍])\p{Cf}|[\u{e0100}-\u{e01ef}]/u
const SPACE = /\s/u
const ASCII_ONLY = /^\p{ASCII}*$/u
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/
const MAX_LABEL = 63
const MAX_HOST = 253

function asUrlHost(text: string): string | undefined {
  try {
    return new URL(`http://${text}`).hostname
  } catch {
    return undefined
  }
}

function addressOf(inner: string, wildcard: boolean): string {
  const canonical = asUrlHost(`[${inner}]`)
  if (canonical === undefined || !canonical.startsWith('[')) throw new RuleInvalidError('host_characters')
  if (wildcard) throw new RuleInvalidError('host_wildcard')
  return canonical
}

function nameOf(base: string, wildcard: boolean): string {
  if (base.split('.').includes('')) throw new RuleInvalidError('host_empty_label')
  if (base.includes('%')) throw new RuleInvalidError('host_characters')
  const plain = ASCII_ONLY.test(base)
  const ascii = domainToASCII(base)
  if (ascii === '') throw new RuleInvalidError(plain ? 'host_characters' : 'host_idn')
  if (plain && ascii !== base) throw new RuleInvalidError('host_characters')
  const labels = ascii.split('.')
  if (labels.includes('')) throw new RuleInvalidError('host_empty_label')
  if (labels.some((label) => label.length > MAX_LABEL)) throw new RuleInvalidError('host_label_length')
  if (ascii.length > MAX_HOST) throw new RuleInvalidError('host_too_long')
  if (!labels.every((label) => LABEL.test(label)) || asUrlHost(ascii) !== ascii) throw new RuleInvalidError('host_characters')
  if (wildcard && IPV4.test(ascii)) throw new RuleInvalidError('host_wildcard')
  return ascii
}

function hostPattern(value: string): string {
  if (SPACE.test(value)) throw new RuleInvalidError('host_space')
  if (value.includes('://')) throw new RuleInvalidError('host_scheme')
  if (value.includes('@')) throw new RuleInvalidError('host_user_info')
  if (/[/?#\\]/.test(value)) throw new RuleInvalidError('host_path')
  const wildcard = value.startsWith('*.')
  const base = wildcard ? value.slice(2) : value
  if (base === '' || base.includes('*')) throw new RuleInvalidError('host_wildcard')
  let host: string
  if (base.startsWith('[')) {
    const close = base.indexOf(']')
    if (close === -1) throw new RuleInvalidError('host_characters')
    const after = base.slice(close + 1)
    if (after !== '') throw new RuleInvalidError(after.startsWith(':') ? 'host_port' : 'host_characters')
    host = addressOf(base.slice(1, close), wildcard)
  } else if (base.split(':').length > 2) {
    host = addressOf(base, wildcard)
  } else if (base.includes(':')) {
    throw new RuleInvalidError('host_port')
  } else {
    host = nameOf(base, wildcard)
  }
  return wildcard ? `*.${host}` : host
}

export function normaliseRule(input: { kind: RuleKind; value: string }, nodeTypes: ReadonlySet<string>): { kind: RuleKind; value: string } {
  const trimmed = input.value.normalize('NFC').trim()
  if (trimmed === '') throw new RuleInvalidError('empty')
  if (CONTROL.test(trimmed)) throw new RuleInvalidError('control_character')
  if (SEPARATOR.test(trimmed)) throw new RuleInvalidError('line_separator')
  if (BIDI.test(trimmed)) throw new RuleInvalidError('bidi_format')
  if (FORMAT.test(trimmed)) throw new RuleInvalidError('format_character')
  if ([...trimmed].length > RULE_MAX_INPUT_CHARS) throw new RuleInvalidError('too_long')
  const lower = trimmed.toLowerCase()
  switch (input.kind) {
    case 'forbidNode': {
      const type = [...nodeTypes].find((candidate) => candidate.toLowerCase() === lower)
      if (type === undefined) throw new RuleInvalidError('unknown_node_type')
      return { kind: input.kind, value: type }
    }
    case 'maxPlanEffort':
      if (!(PLAN_EFFORTS as readonly string[]).includes(lower)) throw new RuleInvalidError('unknown_effort')
      return { kind: input.kind, value: lower }
    case 'allowHost':
      return { kind: input.kind, value: hostPattern(lower) }
  }
}
