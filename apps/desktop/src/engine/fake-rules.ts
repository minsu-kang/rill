import { PLAN_EFFORTS, RULE_MAX_ITEMS, RULE_MAX_INPUT_CHARS, RillError, type MethodParams, type MethodResult, type PlanEffort, type PlanMeta, type Rule } from '@rill/protocol'
import { checkRuleValue, effortCapOf, effortRank, type RuleProblem, type RuleViolation } from '../model/rules'

export type { RuleViolation }
export type RuleViolationScript = (rules: readonly Rule[]) => RuleViolation[]

export interface FakeRulesOptions {
  rules?: readonly Rule[]
  violations?: RuleViolationScript
  now?: () => number
}

export interface FakeRules {
  list(): MethodResult<'listRules'>
  save(params: MethodParams<'saveRule'>, nodeTypes: ReadonlySet<string>): MethodResult<'saveRule'>
  remove(params: MethodParams<'deleteRule'>): MethodResult<'deleteRule'>
  check(): MethodResult<'checkRules'>
  cap(): PlanEffort | undefined
}

const PROBLEM_TEXT: Readonly<Record<RuleProblem, string>> = {
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

export function createFakeRules(options: FakeRulesOptions = {}): FakeRules {
  const saved: Rule[] = structuredClone([...(options.rules ?? [])])
  const now = options.now ?? Date.now
  let serial = 0

  return {
    list: () => ({ rules: structuredClone(saved) }),
    save(params, nodeTypes) {
      const checked = checkRuleValue(params.kind, params.value, nodeTypes)
      if (!checked.ok) throw new RillError('RULE_INVALID', 'the rule is not valid', [`${checked.problem}: ${PROBLEM_TEXT[checked.problem]}`])
      const { value } = checked
      if (params.kind === 'maxPlanEffort') {
        const existing = saved.find((rule) => rule.kind === 'maxPlanEffort')
        if (existing !== undefined) {
          existing.value = value
          return { rule: structuredClone(existing) }
        }
      }
      if (saved.some((rule) => rule.kind === params.kind && rule.value === value)) throw new RillError('RULE_DUPLICATE', 'the same rule is already saved')
      if (saved.length >= RULE_MAX_ITEMS) throw new RillError('RULE_FULL', `at most ${RULE_MAX_ITEMS} rules can be saved; delete one first`)
      serial += 1
      const rule: Rule = { id: `rule-new-${serial}`, kind: params.kind, value, createdAt: now() }
      saved.push(rule)
      return { rule: structuredClone(rule) }
    },
    remove({ id }) {
      const at = saved.findIndex((rule) => rule.id === id)
      if (at < 0) throw new RillError('RULE_NOT_FOUND', 'rule not found')
      saved.splice(at, 1)
      return { deleted: true }
    },
    check: () => ({ violations: structuredClone(options.violations?.(structuredClone(saved)) ?? []) }),
    cap: () => effortCapOf(saved),
  }
}

export function metaUnderCap(meta: PlanMeta, requested: PlanEffort, cap: PlanEffort | undefined): PlanMeta {
  if (cap === undefined || effortRank(requested) <= effortRank(cap)) return meta
  return { ...meta, effort: cap, effortDetail: { requested, effective: cap, native: cap, collapsed: false, cappedByRule: true } }
}
