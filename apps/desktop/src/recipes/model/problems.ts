import { ISSUE_CODES } from '@rill/dsl'
import type { RecipeParamInfo } from '@rill/protocol'
import type { MessageKey } from '../../i18n'
import { truncate } from '../../model/text'

export interface GeneralProblem {
  code: string
  pointer: string
  key: MessageKey
}

export interface FieldProblems {
  fields: Record<string, MessageKey>
  general: GeneralProblem[]
  raw: Record<string, string>
}

const RULE_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({
  required: 'recipes.rule.required',
  unknown_param: 'recipes.rule.unknown_param',
  wrong_type: 'recipes.rule.wrong_type',
  empty: 'recipes.rule.empty',
  too_long: 'recipes.rule.too_long',
  control_character: 'recipes.rule.control_character',
  line_separator: 'recipes.rule.line_separator',
  bidi_format: 'recipes.rule.bidi_format',
  format_character: 'recipes.rule.format_character',
  template_text: 'recipes.rule.template_text',
  surrounding_space: 'recipes.rule.surrounding_space',
  not_absolute_path: 'recipes.rule.not_absolute_path',
  parent_segment: 'recipes.rule.parent_segment',
  trailing_separator: 'recipes.rule.trailing_separator',
  wrong_extension: 'recipes.rule.wrong_extension',
  bad_glob: 'recipes.rule.bad_glob',
  not_finite: 'recipes.rule.not_finite',
  below_min: 'recipes.rule.below_min',
  above_max: 'recipes.rule.above_max',
  bad_cron: 'recipes.rule.bad_cron',
  bad_url: 'recipes.rule.bad_url',
  url_credentials: 'recipes.rule.url_credentials',
})

export const PARAM_RULE_IDS: readonly string[] = Object.keys(RULE_KEYS)

const CONNECTION_KIND_CODE = 'connection_kind_mismatch'

const SPECIFIC_ISSUES: Readonly<Record<string, MessageKey>> = Object.freeze({
  path_outside_roots: 'recipes.issue.path_outside_roots',
  unknown_connection: 'recipes.issue.unknown_connection',
  [CONNECTION_KIND_CODE]: 'recipes.issue.connection_kind_mismatch',
  inside_watched_folder: 'recipes.issue.inside_watched_folder',
  cron_expression: 'recipes.issue.cron_expression',
  config_rule: 'recipes.issue.config',
})

const STRUCTURE_ISSUES: ReadonlySet<string> = new Set([
  'config_json_parse',
  'unknown_node_type',
  'duplicate_id',
  'trigger_count',
  'edge_unknown_node',
  'trigger_incoming',
  'trigger_edge_when',
  'cycle',
  'unreachable',
  'kind_mismatch',
])

const REFERENCE_ISSUES: ReadonlySet<string> = new Set(['unknown_ref_node', 'ref_not_upstream', 'malformed_template', 'unknown_output_field', 'when_not_branching', 'when_unknown_label'])

const WARNING_ISSUES: ReadonlySet<string> = new Set(['branch_unused', 'nullable_into_required', 'number_into_integer'])

function familyKey(code: string): MessageKey | undefined {
  if (Object.hasOwn(SPECIFIC_ISSUES, code)) return SPECIFIC_ISSUES[code]
  if (STRUCTURE_ISSUES.has(code) || code.startsWith('shape_')) return 'recipes.issue.structure'
  if (REFERENCE_ISSUES.has(code)) return 'recipes.issue.reference'
  if (WARNING_ISSUES.has(code)) return 'recipes.issue.warning'
  if (code.startsWith('config_')) return 'recipes.issue.config'
  return undefined
}

export const ISSUE_CODE_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze(
  Object.fromEntries([...ISSUE_CODES, CONNECTION_KIND_CODE].map((code) => [code, familyKey(code) ?? 'recipes.issue.unknown'])),
)

export function ruleKey(rule: string): MessageKey {
  return Object.hasOwn(RULE_KEYS, rule) ? RULE_KEYS[rule]! : 'recipes.rule.generic'
}

export function issueKey(code: string): MessageKey {
  return familyKey(code) ?? 'recipes.issue.unknown'
}

const PARAM_PROBLEM = /^([^\s:]+): ([A-Za-z0-9_]+)$/
const ISSUE_PROBLEM = /^([A-Za-z0-9_]+) at (\/.*)$/
const MAX_RAW = 80

export function problemsToFields(problems: readonly string[], params: readonly RecipeParamInfo[]): FieldProblems {
  const fields: Array<[string, MessageKey]> = []
  const raw: Array<[string, string]> = []
  const general: GeneralProblem[] = []
  for (const problem of problems) {
    const asParam = PARAM_PROBLEM.exec(problem)
    if (asParam !== null) {
      const [, param, rule] = asParam as unknown as [string, string, string]
      const key = ruleKey(rule)
      if (!params.some((candidate) => candidate.id === param)) general.push({ code: rule, pointer: param, key })
      else if (!fields.some(([id]) => id === param)) {
        fields.push([param, key])
        if (key === 'recipes.rule.generic') raw.push([param, rule])
      }
      continue
    }
    const asIssue = ISSUE_PROBLEM.exec(problem)
    if (asIssue !== null) {
      const [, code, pointer] = asIssue as unknown as [string, string, string]
      general.push({ code, pointer, key: issueKey(code) })
      continue
    }
    general.push({ code: truncate(problem, MAX_RAW), pointer: '', key: 'recipes.issue.unknown' })
  }
  return { fields: Object.fromEntries(fields), general, raw: Object.fromEntries(raw) }
}
