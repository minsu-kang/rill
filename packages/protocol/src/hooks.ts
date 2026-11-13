import Type from 'typebox'
import { IdSchema } from './plan'

export const HOOK_EVENTS = ['run.failed', 'run.succeeded', 'plan.deployed'] as const
export const HOOK_ACTION_TYPES = ['notify', 'deactivateAfterFailures', 'record'] as const
export const HOOK_OUTCOMES = ['ok', 'failed', 'skipped_cooldown', 'rate_limited', 'blocked_by_rule', 'skipped_inactive'] as const
export const HOOK_FAILURE_CODES = ['connection', 'timeout', 'http_status', 'slack_error', 'unknown'] as const

export const HOOK_MAX_ITEMS = 20
export const HOOK_FAILURE_COUNT_MIN = 2
export const HOOK_FAILURE_COUNT_MAX = 20
export const HOOK_CONNECTION_MAX_CHARS = 128
export const HOOK_CHANNEL_MAX_CHARS = 80
export const HOOK_CONNECTION_MAX_INPUT_CHARS = 4 * HOOK_CONNECTION_MAX_CHARS
export const HOOK_CHANNEL_MAX_INPUT_CHARS = 4 * HOOK_CHANNEL_MAX_CHARS
export const HOOK_WORKFLOW_LABEL_MAX_CHARS = 60
export const HOOK_COOLDOWN_MS = 60_000
export const HOOK_RATE_LIMIT = 30
export const HOOK_RATE_WINDOW_MS = 600_000
export const HOOK_LOG_MAX_ROWS = 500
export const HOOK_LOG_DEFAULT_LIMIT = 50
export const HOOK_LOG_MAX_LIMIT = 200

const closed = { additionalProperties: false } as const

export const HookEventSchema = Type.Union([Type.Literal('run.failed'), Type.Literal('run.succeeded'), Type.Literal('plan.deployed')])

export const HookScopeSchema = Type.Union([
  Type.Object({ type: Type.Literal('all') }, closed),
  Type.Object({ type: Type.Literal('workflow'), workflowId: IdSchema }, closed),
])

export const HookActionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('notify'),
      connection: Type.String({ minLength: 1, maxLength: HOOK_CONNECTION_MAX_CHARS }),
      channel: Type.Optional(Type.String({ minLength: 1, maxLength: HOOK_CHANNEL_MAX_CHARS })),
    },
    closed,
  ),
  Type.Object({ type: Type.Literal('deactivateAfterFailures'), count: Type.Integer({ minimum: HOOK_FAILURE_COUNT_MIN, maximum: HOOK_FAILURE_COUNT_MAX }) }, closed),
  Type.Object({ type: Type.Literal('record') }, closed),
])

export const HookActionInputSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('notify'),
      connection: Type.String({ maxLength: HOOK_CONNECTION_MAX_INPUT_CHARS }),
      channel: Type.Optional(Type.String({ maxLength: HOOK_CHANNEL_MAX_INPUT_CHARS })),
    },
    closed,
  ),
  Type.Object({ type: Type.Literal('deactivateAfterFailures'), count: Type.Integer() }, closed),
  Type.Object({ type: Type.Literal('record') }, closed),
])

export const HookSchema = Type.Object(
  {
    id: IdSchema,
    event: HookEventSchema,
    scope: HookScopeSchema,
    action: HookActionSchema,
    enabled: Type.Boolean(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  closed,
)

export const HookOutcomeSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('failed'),
  Type.Literal('skipped_cooldown'),
  Type.Literal('rate_limited'),
  Type.Literal('blocked_by_rule'),
  Type.Literal('skipped_inactive'),
])

export const HookFailureCodeSchema = Type.Union([
  Type.Literal('connection'),
  Type.Literal('timeout'),
  Type.Literal('http_status'),
  Type.Literal('slack_error'),
  Type.Literal('unknown'),
])

export const HookLogEntrySchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    hookId: IdSchema,
    at: Type.Number(),
    event: HookEventSchema,
    workflowId: IdSchema,
    outcome: HookOutcomeSchema,
    code: Type.Union([HookFailureCodeSchema, Type.Null()]),
  },
  closed,
)

export type HookEvent = (typeof HOOK_EVENTS)[number]
export type HookActionType = (typeof HOOK_ACTION_TYPES)[number]
export type HookOutcome = (typeof HOOK_OUTCOMES)[number]
export type HookFailureCode = (typeof HOOK_FAILURE_CODES)[number]
export type HookScope = Type.Static<typeof HookScopeSchema>
export type HookAction = Type.Static<typeof HookActionSchema>
export type HookActionInput = Type.Static<typeof HookActionInputSchema>
export type Hook = Type.Static<typeof HookSchema>
export type HookLogEntry = Type.Static<typeof HookLogEntrySchema>

export interface HookInput {
  event: HookEvent
  scope: HookScope
  action: HookActionInput
  enabled: boolean
}

export type HookField = 'event' | 'scope' | 'action' | 'connection' | 'channel' | 'count' | 'hook'
export type HookRule =
  | 'empty'
  | 'control_character'
  | 'line_separator'
  | 'bidi_format'
  | 'format_character'
  | 'too_long'
  | 'whitespace'
  | 'unknown_workflow'
  | 'unknown_connection'
  | 'not_slack_connection'
  | 'forbidden_by_rule'
  | 'out_of_range'
  | 'only_for_run_failed'
  | 'duplicate'

export interface HookProblem {
  field: HookField
  rule: HookRule
}

export const HOOK_FIELDS: readonly HookField[] = ['event', 'scope', 'action', 'connection', 'channel', 'count', 'hook']
export const HOOK_RULES: readonly HookRule[] = [
  'empty',
  'control_character',
  'line_separator',
  'bidi_format',
  'format_character',
  'too_long',
  'whitespace',
  'unknown_workflow',
  'unknown_connection',
  'not_slack_connection',
  'forbidden_by_rule',
  'out_of_range',
  'only_for_run_failed',
  'duplicate',
]

export type HookTextField = 'connection' | 'channel'
export type HookTextCheck = { ok: true; value: string } | { ok: false; rule: HookRule }

const CONTROL = /\p{Cc}/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const FORMAT = /(?![\u200c\u200d])\p{Cf}|[\u{e0100}-\u{e01ef}]|\p{Cs}/u
const BLANK = /\s/u

export function normaliseHookText(field: HookTextField, raw: string): HookTextCheck {
  const text = field === 'channel' ? raw.normalize('NFC').trim() : raw
  if (field === 'channel' && text === '') return { ok: true, value: '' }
  if (field === 'connection' && raw.trim() === '') return { ok: false, rule: 'empty' }
  if (CONTROL.test(text)) return { ok: false, rule: 'control_character' }
  if (SEPARATOR.test(text)) return { ok: false, rule: 'line_separator' }
  if (BIDI.test(text)) return { ok: false, rule: 'bidi_format' }
  if (FORMAT.test(text)) return { ok: false, rule: 'format_character' }
  if (field === 'channel') {
    if (BLANK.test(text)) return { ok: false, rule: 'whitespace' }
    if (text.length > HOOK_CHANNEL_MAX_CHARS) return { ok: false, rule: 'too_long' }
  } else if ([...text].length > HOOK_CONNECTION_MAX_CHARS) {
    return { ok: false, rule: 'too_long' }
  }
  return { ok: true, value: text }
}

export type HookConnectionKind = 'slack' | 'other' | 'missing'

export interface HookCheckEnv {
  workflowExists(id: string): boolean
  connectionKind(name: string): HookConnectionKind
  notifyForbidden: boolean
}

export type HookCheck = { ok: true; input: HookInput } | { ok: false; problems: HookProblem[] }

function checkNotify(action: { connection: string; channel?: string | undefined }, env: HookCheckEnv, problems: HookProblem[]): HookActionInput {
  const connection = normaliseHookText('connection', action.connection)
  const channel = normaliseHookText('channel', action.channel ?? '')
  if (!connection.ok) problems.push({ field: 'connection', rule: connection.rule })
  else {
    const kind = env.connectionKind(connection.value)
    if (kind === 'missing') problems.push({ field: 'connection', rule: 'unknown_connection' })
    else if (kind !== 'slack') problems.push({ field: 'connection', rule: 'not_slack_connection' })
  }
  if (!channel.ok) problems.push({ field: 'channel', rule: channel.rule })
  if (env.notifyForbidden) problems.push({ field: 'action', rule: 'forbidden_by_rule' })
  return {
    type: 'notify',
    connection: connection.ok ? connection.value : '',
    ...(channel.ok && channel.value !== '' ? { channel: channel.value } : {}),
  }
}

export function checkHookInput(input: HookInput, env: HookCheckEnv): HookCheck {
  const problems: HookProblem[] = []
  if (input.scope.type === 'workflow' && !env.workflowExists(input.scope.workflowId)) problems.push({ field: 'scope', rule: 'unknown_workflow' })
  let action: HookActionInput
  switch (input.action.type) {
    case 'notify':
      action = checkNotify(input.action, env, problems)
      break
    case 'deactivateAfterFailures': {
      const { count } = input.action
      if (!Number.isInteger(count) || count < HOOK_FAILURE_COUNT_MIN || count > HOOK_FAILURE_COUNT_MAX) problems.push({ field: 'count', rule: 'out_of_range' })
      if (input.event !== 'run.failed') problems.push({ field: 'action', rule: 'only_for_run_failed' })
      action = { type: 'deactivateAfterFailures', count }
      break
    }
    case 'record':
      action = { type: 'record' }
      break
  }
  if (problems.length > 0) return { ok: false, problems }
  const scope: HookScope = input.scope.type === 'all' ? { type: 'all' } : { type: 'workflow', workflowId: input.scope.workflowId }
  return { ok: true, input: { event: input.event, scope, action, enabled: input.enabled } }
}

export function hookKey(input: HookInput): string {
  const { action } = input
  return JSON.stringify([
    input.event,
    input.scope.type === 'all' ? null : input.scope.workflowId,
    action.type,
    action.type === 'notify' ? action.connection : null,
    action.type === 'notify' ? (action.channel ?? null) : null,
    action.type === 'deactivateAfterFailures' ? action.count : null,
  ])
}

const RULE_SENTENCE: Readonly<Record<HookRule, string>> = {
  empty: 'a value is required',
  control_character: 'the text has no control characters',
  line_separator: 'the text has no line or paragraph separators',
  bidi_format: 'the text has no bidirectional formatting characters',
  format_character: 'the text has no invisible format characters',
  too_long: 'the text is too long',
  whitespace: 'the channel has no spaces',
  unknown_workflow: 'the workflow does not exist',
  unknown_connection: 'no saved connection has this name',
  not_slack_connection: 'the connection is not a Slack connection',
  forbidden_by_rule: 'a rule forbids notify.slack, so a notify hook is refused',
  out_of_range: `the count is a whole number from ${HOOK_FAILURE_COUNT_MIN} to ${HOOK_FAILURE_COUNT_MAX}`,
  only_for_run_failed: 'this action works only for the event run.failed',
  duplicate: 'a hook with the same event, scope and action is already saved',
}

export function hookProblemLine(problem: HookProblem): string {
  return `${problem.field}.${problem.rule}: ${RULE_SENTENCE[problem.rule]}`
}

const PROBLEM_LINE = /^([a-z]+)\.([a-z_]+): \S.*$/s

export function parseHookProblemLine(line: string): HookProblem | undefined {
  const match = PROBLEM_LINE.exec(line)
  if (match === null) return undefined
  const field = HOOK_FIELDS.find((candidate) => candidate === match[1])
  const rule = HOOK_RULES.find((candidate) => candidate === match[2])
  return field === undefined || rule === undefined ? undefined : { field, rule }
}

const LABEL_HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/u
const LABEL_SCAN_LIMIT = 10_000
const LABEL_FALLBACK = 'unnamed'
const SLACK_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

export function hookWorkflowLabel(name: string): string {
  let kept = ''
  let length = 0
  let scanned = 0
  let gap = false
  for (const char of name) {
    scanned += 1
    if (scanned > LABEL_SCAN_LIMIT) break
    if (LABEL_HIDDEN.test(char)) continue
    if (BLANK.test(char)) {
      gap = kept !== ''
      continue
    }
    if (gap) {
      if (length >= HOOK_WORKFLOW_LABEL_MAX_CHARS) break
      kept += ' '
      length += 1
      gap = false
    }
    if (length >= HOOK_WORKFLOW_LABEL_MAX_CHARS) break
    kept += char
    length += 1
  }
  const label = kept.trimEnd()
  return label === '' ? LABEL_FALLBACK : label.replace(/[&<>]/g, (char) => SLACK_ESCAPES[char]!)
}

export function hookMessage(event: HookEvent, workflowName: string): string {
  const label = hookWorkflowLabel(workflowName)
  switch (event) {
    case 'run.failed':
      return `Workflow "${label}" failed.`
    case 'run.succeeded':
      return `Workflow "${label}" finished.`
    case 'plan.deployed':
      return `Workflow "${label}" was deployed.`
  }
}
