import { PLAN_EFFORTS, RULE_MAX_INPUT_CHARS, type MethodResult, type NodeInfo, type PlanEffort, type Rule, type RuleKind } from '@rill/protocol'

export type RuleViolation = MethodResult<'checkRules'>['violations'][number]

export const RULE_PROBLEMS = [
  'empty',
  'control_character',
  'line_separator',
  'bidi_format',
  'format_character',
  'too_long',
  'unknown_node_type',
  'unknown_effort',
  'host_scheme',
  'host_path',
  'host_port',
  'host_user_info',
  'host_space',
  'host_empty_label',
  'host_wildcard',
  'host_characters',
  'host_label_length',
  'host_too_long',
  'host_idn',
] as const

export type RuleProblem = (typeof RULE_PROBLEMS)[number]
export type RuleCheck = { ok: true; value: string } | { ok: false; problem: RuleProblem }

const CONTROL = /\p{Cc}/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const FORMAT = /(?![\u200c\u200d])\p{Cf}|[\u{e0100}-\u{e01ef}]/u
const SPACE = /\s/u
const ASCII_ONLY = /^\p{ASCII}*$/u
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/
const MAX_LABEL = 63
const MAX_HOST = 253

class Refused extends Error {
  readonly problem: RuleProblem

  constructor(problem: RuleProblem) {
    super(problem)
    this.problem = problem
  }
}

function asUrlHost(text: string): string | undefined {
  try {
    return new URL(`http://${text}`).hostname
  } catch {
    return undefined
  }
}

function addressOf(inner: string, wildcard: boolean): string {
  const canonical = asUrlHost(`[${inner}]`)
  if (canonical === undefined || !canonical.startsWith('[')) throw new Refused('host_characters')
  if (wildcard) throw new Refused('host_wildcard')
  return canonical
}

function nameOf(base: string, wildcard: boolean): string {
  if (base.split('.').includes('')) throw new Refused('host_empty_label')
  if (base.includes('%')) throw new Refused('host_characters')
  const plain = ASCII_ONLY.test(base)
  const ascii = asUrlHost(base) ?? ''
  if (ascii === '') throw new Refused(plain ? 'host_characters' : 'host_idn')
  if (plain && ascii !== base) throw new Refused('host_characters')
  const labels = ascii.split('.')
  if (labels.includes('')) throw new Refused('host_empty_label')
  if (labels.some((label) => label.length > MAX_LABEL)) throw new Refused('host_label_length')
  if (ascii.length > MAX_HOST) throw new Refused('host_too_long')
  if (!labels.every((label) => LABEL.test(label)) || asUrlHost(ascii) !== ascii) throw new Refused('host_characters')
  if (wildcard && IPV4.test(ascii)) throw new Refused('host_wildcard')
  return ascii
}

function hostPattern(value: string): string {
  if (SPACE.test(value)) throw new Refused('host_space')
  if (value.includes('://')) throw new Refused('host_scheme')
  if (value.includes('@')) throw new Refused('host_user_info')
  if (/[/?#\\]/.test(value)) throw new Refused('host_path')
  const wildcard = value.startsWith('*.')
  const base = wildcard ? value.slice(2) : value
  if (base === '' || base.includes('*')) throw new Refused('host_wildcard')
  let host: string
  if (base.startsWith('[')) {
    const close = base.indexOf(']')
    if (close === -1) throw new Refused('host_characters')
    const after = base.slice(close + 1)
    if (after !== '') throw new Refused(after.startsWith(':') ? 'host_port' : 'host_characters')
    host = addressOf(base.slice(1, close), wildcard)
  } else if (base.split(':').length > 2) {
    host = addressOf(base, wildcard)
  } else if (base.includes(':')) {
    throw new Refused('host_port')
  } else {
    host = nameOf(base, wildcard)
  }
  return wildcard ? `*.${host}` : host
}

function normalised(kind: RuleKind, raw: string, nodeTypes: ReadonlySet<string>): string {
  const trimmed = raw.normalize('NFC').trim()
  if (trimmed === '') throw new Refused('empty')
  if (CONTROL.test(trimmed)) throw new Refused('control_character')
  if (SEPARATOR.test(trimmed)) throw new Refused('line_separator')
  if (BIDI.test(trimmed)) throw new Refused('bidi_format')
  if (FORMAT.test(trimmed)) throw new Refused('format_character')
  if ([...trimmed].length > RULE_MAX_INPUT_CHARS) throw new Refused('too_long')
  const lower = trimmed.toLowerCase()
  switch (kind) {
    case 'forbidNode': {
      const type = [...nodeTypes].find((candidate) => candidate.toLowerCase() === lower)
      if (type === undefined) throw new Refused('unknown_node_type')
      return type
    }
    case 'maxPlanEffort':
      if (!(PLAN_EFFORTS as readonly string[]).includes(lower)) throw new Refused('unknown_effort')
      return lower
    case 'allowHost':
      return hostPattern(lower)
  }
}

export function checkRuleValue(kind: RuleKind, raw: string, nodeTypes: ReadonlySet<string>): RuleCheck {
  try {
    return { ok: true, value: normalised(kind, raw, nodeTypes) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.problem }
    throw error
  }
}

export function effortRank(effort: PlanEffort): number {
  return PLAN_EFFORTS.indexOf(effort)
}

export function cappedEffort(requested: PlanEffort, cap: PlanEffort | undefined): PlanEffort {
  return cap !== undefined && effortRank(requested) > effortRank(cap) ? cap : requested
}

export function closestLevel(levels: readonly PlanEffort[], wanted: PlanEffort): PlanEffort {
  const own = PLAN_EFFORTS.filter((level) => levels.includes(level))
  if (own.length === 0) return wanted
  return own.filter((level) => effortRank(level) <= effortRank(wanted)).at(-1) ?? own[0]!
}

export function widensCap(saved: PlanEffort | undefined, next: PlanEffort | 'none'): boolean {
  const reach = (choice: PlanEffort | 'none' | undefined): number => (choice === undefined || choice === 'none' ? PLAN_EFFORTS.length : effortRank(choice) + 1)
  return reach(next) > reach(saved)
}

export function isPlanEffort(value: string): value is PlanEffort {
  return (PLAN_EFFORTS as readonly string[]).includes(value)
}

export interface RuleGroups {
  forbidden: Rule[]
  hosts: Rule[]
  cap: Rule | undefined
}

export function splitRules(rules: readonly Rule[]): RuleGroups {
  return {
    forbidden: rules.filter((rule) => rule.kind === 'forbidNode'),
    hosts: rules.filter((rule) => rule.kind === 'allowHost'),
    cap: rules.find((rule) => rule.kind === 'maxPlanEffort'),
  }
}

export function effortCapOf(rules: readonly Rule[]): PlanEffort | undefined {
  const value = splitRules(rules).cap?.value
  return value !== undefined && isPlanEffort(value) ? value : undefined
}

export interface ForbiddableNode {
  type: string
  title: string
}

export function baseNodeType(type: string): string {
  return type.replace(/@\d+$/, '')
}

export function forbiddableNodes(catalog: readonly Pick<NodeInfo, 'type' | 'title'>[]): ForbiddableNode[] {
  const seen = new Set<string>()
  const list: ForbiddableNode[] = []
  for (const entry of catalog) {
    const type = baseNodeType(entry.type)
    if (seen.has(type)) continue
    seen.add(type)
    list.push({ type, title: entry.title })
  }
  return list
}

const RULE_MESSAGE = /^node [^:\n]+: (?:the node type \S+ is forbidden by the rules|the host \S+ is not in the allowed hosts|the host of this URL is only known at run time; with allowed hosts set, write the host into the URL|the URL is not a valid absolute http or https URL)$/

export function isRuleMessage(message: string): boolean {
  return RULE_MESSAGE.test(message)
}
