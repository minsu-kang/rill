import {
  checkHookInput,
  hookKey,
  parseHookProblemLine,
  type Hook,
  type HookAction,
  type HookActionType,
  type HookConnectionKind,
  type HookEvent,
  type HookInput,
  type HookProblem,
  type HookRule,
  type HookScope,
  type Rule,
} from '@rill/protocol'
import type { MessageKey, Translate } from '../../../i18n'
import { baseNodeType } from '../../../model/rules'
import type { ConnectionSummary } from '../../../shared/host-api'

export interface HookDraft {
  event: HookEvent
  scopeId: string
  action: HookActionType
  connection: string
  channel: string
  count: string
  enabled: boolean
}

export const NEW_HOOK_DRAFT: HookDraft = { event: 'run.failed', scopeId: '', action: 'notify', connection: '', channel: '', count: '3', enabled: true }

export function draftOf(hook: Hook): HookDraft {
  const { action } = hook
  return {
    event: hook.event,
    scopeId: hook.scope.type === 'all' ? '' : hook.scope.workflowId,
    action: action.type,
    connection: action.type === 'notify' ? action.connection : '',
    channel: action.type === 'notify' ? (action.channel ?? '') : '',
    count: action.type === 'deactivateAfterFailures' ? String(action.count) : NEW_HOOK_DRAFT.count,
    enabled: hook.enabled,
  }
}

const WHOLE_NUMBER = /^\d+$/

export function hookInputOf(draft: HookDraft): HookInput {
  const scope: HookInput['scope'] = draft.scopeId === '' ? { type: 'all' } : { type: 'workflow', workflowId: draft.scopeId }
  const text = draft.count.trim()
  const action: HookInput['action'] =
    draft.action === 'notify'
      ? { type: 'notify', connection: draft.connection, ...(draft.channel.trim() === '' ? {} : { channel: draft.channel }) }
      : draft.action === 'deactivateAfterFailures'
        ? { type: 'deactivateAfterFailures', count: WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN }
        : { type: 'record' }
  return { event: draft.event, scope, action, enabled: draft.enabled }
}

export function sameDraft(a: HookDraft, b: HookDraft): boolean {
  return a.event === b.event && a.scopeId === b.scopeId && a.action === b.action && a.connection === b.connection && a.channel === b.channel && a.count === b.count && a.enabled === b.enabled
}

export type HookConnection = Pick<ConnectionSummary, 'name' | 'kind' | 'slack'>

export interface HookEnv {
  workflowIds: ReadonlySet<string> | undefined
  connections: readonly HookConnection[] | undefined
  notifyForbidden: boolean
}

export interface DraftCheck {
  problems: HookProblem[]
  input: HookInput | undefined
  canSave: boolean
}

function connectionKind(connections: readonly HookConnection[] | undefined, name: string): HookConnectionKind {
  if (connections === undefined) return 'slack'
  const found = connections.find((entry) => entry.name === name)
  return found === undefined ? 'missing' : found.kind === 'slack' ? 'slack' : 'other'
}

export function inputOfHook(hook: Hook): HookInput {
  return { event: hook.event, scope: hook.scope, action: hook.action, enabled: hook.enabled }
}

export function checkDraft(draft: HookDraft, env: HookEnv, saved: readonly Hook[], editingId: string | undefined): DraftCheck {
  const checked = checkHookInput(hookInputOf(draft), {
    workflowExists: (id) => env.workflowIds === undefined || env.workflowIds.has(id),
    connectionKind: (name) => connectionKind(env.connections, name),
    notifyForbidden: env.notifyForbidden,
  })
  if (!checked.ok) return { problems: checked.problems, input: undefined, canSave: false }
  const key = hookKey(checked.input)
  if (saved.some((hook) => hook.id !== editingId && hookKey(inputOfHook(hook)) === key)) {
    return { problems: [{ field: 'hook', rule: 'duplicate' }], input: undefined, canSave: false }
  }
  return { problems: [], input: checked.input, canSave: true }
}

export function notifyForbiddenBy(rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.kind === 'forbidNode' && baseNodeType(rule.value).toLowerCase() === 'notify.slack')
}

const RULE_KEYS: Readonly<Record<Exclude<HookRule, 'too_long'>, MessageKey>> = {
  empty: 'agents.hooks.problem.empty',
  control_character: 'agents.hooks.problem.control_character',
  line_separator: 'agents.hooks.problem.line_separator',
  bidi_format: 'agents.hooks.problem.bidi_format',
  format_character: 'agents.hooks.problem.format_character',
  whitespace: 'agents.hooks.problem.whitespace',
  unknown_workflow: 'agents.hooks.problem.unknown_workflow',
  unknown_connection: 'agents.hooks.problem.unknown_connection',
  not_slack_connection: 'agents.hooks.problem.not_slack_connection',
  forbidden_by_rule: 'agents.hooks.problem.forbidden_by_rule',
  out_of_range: 'agents.hooks.problem.out_of_range',
  only_for_run_failed: 'agents.hooks.problem.only_for_run_failed',
  duplicate: 'agents.hooks.problem.duplicate',
}

export function problemKey(problem: HookProblem): MessageKey {
  if (problem.rule === 'too_long') return problem.field === 'channel' ? 'agents.hooks.problem.channelTooLong' : 'agents.hooks.problem.connectionTooLong'
  return RULE_KEYS[problem.rule]
}

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  HOOK_FULL: 'agents.hooks.error.HOOK_FULL',
  HOOK_NOT_FOUND: 'agents.hooks.error.HOOK_NOT_FOUND',
  INVALID_PARAMS: 'agents.hooks.error.INVALID_PARAMS',
}

export function hookErrorKey(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'HOOK_INVALID') {
    const problems = (error as { problems?: unknown }).problems
    for (const line of Array.isArray(problems) ? problems : []) {
      const problem = typeof line === 'string' ? parseHookProblemLine(line) : undefined
      if (problem !== undefined) return problemKey(problem)
    }
    return 'agents.hooks.error.HOOK_INVALID'
  }
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code]! : 'agents.hooks.error.generic'
}

const PAGE_KEYS: Readonly<Partial<Record<MessageKey, MessageKey>>> = {
  'agents.hooks.problem.unknown_workflow': 'agents.hooks.error.switchOn',
  'agents.hooks.problem.unknown_connection': 'agents.hooks.error.switchOn',
  'agents.hooks.problem.forbidden_by_rule': 'agents.hooks.error.switchOn',
}

export function pageErrorKey(key: MessageKey): MessageKey {
  return PAGE_KEYS[key] ?? key
}

export interface HookLabels {
  event(event: HookEvent): string
  scope(scope: HookScope): string
  action(action: HookAction): string
  summary(hook: Pick<Hook, 'event' | 'scope' | 'action'>): string
}

export function hookLabels(t: Translate, names: ReadonlyMap<string, string>, clip: (text: string) => string): HookLabels {
  const event = (value: HookEvent): string => t(`agents.hooks.event.${value}`)
  const scope = (value: HookScope): string => {
    if (value.type === 'all') return t('agents.hooks.scope.all')
    const name = names.get(value.workflowId)
    return name === undefined ? t('agents.hooks.scope.unknown') : clip(name)
  }
  const action = (value: HookAction): string => {
    switch (value.type) {
      case 'notify':
        return value.channel === undefined ? t('agents.hooks.action.notify', { connection: clip(value.connection) }) : t('agents.hooks.action.notifyChannel', { connection: clip(value.connection), channel: clip(value.channel) })
      case 'deactivateAfterFailures':
        return t('agents.hooks.action.deactivate', { count: value.count })
      case 'record':
        return t('agents.hooks.action.record')
    }
  }
  return {
    event,
    scope,
    action,
    summary: (hook) => t('agents.hooks.summary', { event: event(hook.event), scope: scope(hook.scope), action: action(hook.action) }),
  }
}
