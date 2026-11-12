export type IssueStage = 1 | 2 | 3 | 4

export const SCHEMA_KEYWORDS = [
  'type',
  'required',
  'additionalProperties',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'const',
  'enum',
  'anyOf',
  'invalid',
] as const

export type SchemaKeyword = (typeof SCHEMA_KEYWORDS)[number]

export const ISSUE_CODES = [
  'config_json_parse',
  ...SCHEMA_KEYWORDS.map((keyword) => `shape_${keyword}` as const),
  'unknown_node_type',
  'duplicate_id',
  'trigger_count',
  'edge_unknown_node',
  'trigger_incoming',
  'trigger_edge_when',
  'cycle',
  'unreachable',
  'kind_mismatch',
  'unknown_ref_node',
  'ref_not_upstream',
  'malformed_template',
  'unknown_output_field',
  'when_not_branching',
  'when_unknown_label',
  'branch_unused',
  ...SCHEMA_KEYWORDS.map((keyword) => `config_${keyword}` as const),
  'config_rule',
  'cron_expression',
  'nullable_into_required',
  'number_into_integer',
  'path_outside_roots',
  'unknown_connection',
  'inside_watched_folder',
] as const

export type IssueCode = (typeof ISSUE_CODES)[number]

export const WARNING_CODES: readonly IssueCode[] = ['branch_unused', 'nullable_into_required', 'number_into_integer']

export interface PlanIssue {
  stage: IssueStage
  pointer: string
  code: string
  message: string
  hint?: string
}

export function isWarningIssue(issue: PlanIssue): boolean {
  return (WARNING_CODES as readonly string[]).includes(issue.code)
}

export function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

export function joinPointer(base: string, ...segments: (string | number)[]): string {
  return base + segments.map((segment) => `/${escapePointerSegment(String(segment))}`).join('')
}

function compareSegments(left: string, right: string): number {
  const a = left.split('/')
  const b = right.split('/')
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (numeric) return Number(x) - Number(y)
    return x < y ? -1 : 1
  }
  return a.length - b.length
}

export function compareIssues(left: PlanIssue, right: PlanIssue): number {
  return left.stage - right.stage || compareSegments(left.pointer, right.pointer)
}

export function sortIssues(issues: readonly PlanIssue[]): PlanIssue[] {
  return [...issues].sort(compareIssues)
}

export function capIssues(issues: readonly PlanIssue[], options: { max?: number } = {}): PlanIssue[] {
  const max = options.max ?? 20
  const errors = issues.filter((issue) => !isWarningIssue(issue))
  const warnings = issues.filter((issue) => isWarningIssue(issue))
  return [...sortIssues(errors), ...sortIssues(warnings)].slice(0, Math.max(0, max))
}

export interface SchemaErrorLike {
  keyword: string
  instancePath: string
  schemaPath: string
  params: unknown
  message: string
}

export interface SchemaIssueOptions {
  stage: IssueStage
  prefix: 'shape' | 'config'
  base: string
  describe: (relativePointer: string, message: string) => string
}

function keywordOf(keyword: string): SchemaKeyword {
  return (SCHEMA_KEYWORDS as readonly string[]).includes(keyword) ? (keyword as SchemaKeyword) : 'invalid'
}

function namesOf(params: unknown, key: string): string[] {
  const value = (params as Record<string, unknown> | null)?.[key]
  return Array.isArray(value) ? value.map(String) : []
}

export function schemaIssues(errors: readonly SchemaErrorLike[], options: SchemaIssueOptions): PlanIssue[] {
  const issues: PlanIssue[] = []
  const anyOfAt = new Set(errors.filter((e) => e.keyword === 'anyOf').map((e) => e.instancePath))
  const push = (relative: string, keyword: SchemaKeyword, message: string, hint?: string) => {
    issues.push({
      stage: options.stage,
      pointer: options.base + relative,
      code: `${options.prefix}_${keyword}`,
      message: options.describe(relative, message),
      ...(hint === undefined ? {} : { hint }),
    })
  }
  for (const error of errors) {
    const at = error.instancePath
    if (error.keyword === 'boolean') continue
    if (error.keyword === 'anyOf') {
      const branches = errors.filter((e) => e.instancePath === at && e.keyword !== 'anyOf')
      const allowed = branches.filter((e) => e.keyword === 'const').map((e) => (e.params as { allowedValue?: unknown }).allowedValue)
      if (allowed.length > 0) {
        const list = allowed.map((value) => JSON.stringify(value)).join(', ')
        push(at, 'anyOf', `must be one of ${list}`, `use one of: ${allowed.map(String).join(', ')}`)
      } else {
        const types = branches.filter((e) => e.keyword === 'type').map((e) => String((e.params as { type?: unknown }).type))
        push(at, 'anyOf', types.length > 0 ? `must be ${types.join(' or ')}` : error.message)
      }
      continue
    }
    if (anyOfAt.has(at) && error.schemaPath.includes('/anyOf/')) continue
    if (error.keyword === 'required') {
      for (const name of namesOf(error.params, 'requiredProperties')) {
        push(joinPointer(at, name), 'required', `${name} is required`)
      }
      continue
    }
    if (error.keyword === 'additionalProperties') {
      for (const name of namesOf(error.params, 'additionalProperties')) {
        push(joinPointer(at, name), 'additionalProperties', `${name} is not allowed`)
      }
      continue
    }
    push(at, keywordOf(error.keyword), error.message)
  }
  return issues
}
