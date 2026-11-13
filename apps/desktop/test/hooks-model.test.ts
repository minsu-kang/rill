// @vitest-environment node
import { HOOK_EVENTS, HOOK_RULES, RillError, hookProblemLine, type Hook, type HookRule, type Rule } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { NEW_HOOK_DRAFT, checkDraft, draftOf, hookErrorKey, hookInputOf, notifyForbiddenBy, pageErrorKey, problemKey, sameDraft, type HookDraft, type HookEnv } from '../src/app/agents/model/hooks'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'

const ENV: HookEnv = {
  workflowIds: new Set(['wf-a', 'wf-b']),
  connections: [
    { name: 'team-slack', kind: 'slack', slack: { mode: 'bot', channel: '#alerts' } },
    { name: 'ops-webhook', kind: 'slack' },
    { name: 'api-main', kind: 'http' },
  ],
  notifyForbidden: false,
}

const draft = (extra: Partial<HookDraft> = {}): HookDraft => ({ ...NEW_HOOK_DRAFT, connection: 'team-slack', ...extra })
const rulesOf = (draftValue: HookDraft, env: HookEnv = ENV, saved: readonly Hook[] = [], editing?: string): string[] => checkDraft(draftValue, env, saved, editing).problems.map((problem) => `${problem.field}.${problem.rule}`)

function hook(id: string, input: Pick<Hook, 'event' | 'scope' | 'action'> & { enabled?: boolean }): Hook {
  return { id, enabled: true, createdAt: 1, updatedAt: 1, ...input }
}

describe('the draft of a hook', () => {
  it('starts as a Slack notice for a failed run of any workflow, switched on, with nothing chosen yet', () => {
    expect(NEW_HOOK_DRAFT).toEqual({ event: 'run.failed', scopeId: '', action: 'notify', connection: '', channel: '', count: '3', enabled: true })
  })

  it.each<[string, Hook, HookDraft]>([
    ['a notice', hook('h1', { event: 'run.succeeded', scope: { type: 'workflow', workflowId: 'wf-a' }, action: { type: 'notify', connection: 'team-slack', channel: '#ok' } }), { event: 'run.succeeded', scopeId: 'wf-a', action: 'notify', connection: 'team-slack', channel: '#ok', count: '3', enabled: true }],
    ['a notice without a channel', hook('h2', { event: 'plan.deployed', scope: { type: 'all' }, action: { type: 'notify', connection: 'ops-webhook' }, enabled: false }), { event: 'plan.deployed', scopeId: '', action: 'notify', connection: 'ops-webhook', channel: '', count: '3', enabled: false }],
    ['a switch off', hook('h3', { event: 'run.failed', scope: { type: 'all' }, action: { type: 'deactivateAfterFailures', count: 7 } }), { event: 'run.failed', scopeId: '', action: 'deactivateAfterFailures', connection: '', channel: '', count: '7', enabled: true }],
    ['a record', hook('h4', { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' } }), { event: 'run.failed', scopeId: '', action: 'record', connection: '', channel: '', count: '3', enabled: true }],
  ])('is made from %s', (_name, saved, expected) => {
    expect(draftOf(saved)).toEqual(expected)
  })

  it('becomes the input of saveHook with only the fields of its action', () => {
    expect(hookInputOf(draft({ scopeId: 'wf-a', channel: '#alerts' }))).toEqual({ event: 'run.failed', scope: { type: 'workflow', workflowId: 'wf-a' }, action: { type: 'notify', connection: 'team-slack', channel: '#alerts' }, enabled: true })
    expect(hookInputOf(draft({ channel: '   ' })).action).toEqual({ type: 'notify', connection: 'team-slack' })
    expect(hookInputOf(draft({ action: 'deactivateAfterFailures', count: ' 5 ' })).action).toEqual({ type: 'deactivateAfterFailures', count: 5 })
    expect(hookInputOf(draft({ action: 'record' })).action).toEqual({ type: 'record' })
    expect(hookInputOf(draft({ enabled: false })).enabled).toBe(false)
  })

  it.each(['', ' ', 'x', '2.5', '-3', '1e1', '0x10', '３'])('turns the count %j into a number that the check refuses', (count) => {
    const { action } = hookInputOf(draft({ action: 'deactivateAfterFailures', count }))
    expect(action.type === 'deactivateAfterFailures' && Number.isInteger(action.count)).toBe(false)
  })

  it('compares two drafts field by field', () => {
    expect(sameDraft(draft(), draft())).toBe(true)
    for (const change of [{ event: 'run.succeeded' }, { scopeId: 'wf-a' }, { action: 'record' }, { connection: 'other' }, { channel: '#x' }, { count: '4' }, { enabled: false }] as const) {
      expect(sameDraft(draft(), draft(change)), JSON.stringify(change)).toBe(false)
    }
  })
})

describe('the check of a draft uses the check of the engine', () => {
  it('accepts a complete notice, a switch off and a record', () => {
    expect(checkDraft(draft(), ENV, [], undefined).canSave).toBe(true)
    expect(checkDraft(draft({ action: 'deactivateAfterFailures', count: '2' }), ENV, [], undefined).canSave).toBe(true)
    expect(checkDraft(draft({ action: 'deactivateAfterFailures', count: '20' }), ENV, [], undefined).canSave).toBe(true)
    expect(checkDraft(draft({ action: 'record', connection: '' }), ENV, [], undefined).canSave).toBe(true)
  })

  it('refuses a switch off for every event except a failed run', () => {
    for (const event of HOOK_EVENTS) {
      expect(rulesOf(draft({ event, action: 'deactivateAfterFailures' })), event).toEqual(event === 'run.failed' ? [] : ['action.only_for_run_failed'])
    }
  })

  it.each(['1', '21', '2.5', '', 'x'])('refuses the count %j', (count) => {
    expect(rulesOf(draft({ action: 'deactivateAfterFailures', count }))).toEqual(['count.out_of_range'])
  })

  it('needs a connection that is saved and is a Slack connection, when the hook is switched on', () => {
    expect(rulesOf(draft({ connection: '' }))).toEqual(['connection.empty'])
    expect(rulesOf(draft({ connection: 'gone' }))).toEqual(['connection.unknown_connection'])
    expect(rulesOf(draft({ connection: 'api-main' }))).toEqual(['connection.not_slack_connection'])
    expect(rulesOf(draft({ connection: 'Team-Slack' }))).toEqual(['connection.unknown_connection'])
  })

  it('lets a hook that is switched off keep a connection that is gone or of another kind, so that it can always be switched off', () => {
    expect(rulesOf(draft({ connection: 'gone', enabled: false }))).toEqual([])
    expect(rulesOf(draft({ connection: 'api-main', enabled: false }))).toEqual([])
    expect(rulesOf(draft({ connection: '', enabled: false }))).toEqual(['connection.empty'])
  })

  it('does not judge the connection while the connections are not known', () => {
    expect(rulesOf(draft({ connection: 'anything' }), { ...ENV, connections: undefined })).toEqual([])
  })

  it('refuses a notice, but only a switched-on one, while a rule forbids notify.slack', () => {
    const forbidden = { ...ENV, notifyForbidden: true }
    expect(rulesOf(draft(), forbidden)).toEqual(['action.forbidden_by_rule'])
    expect(rulesOf(draft({ enabled: false }), forbidden)).toEqual([])
    expect(rulesOf(draft({ action: 'record' }), forbidden)).toEqual([])
    expect(rulesOf(draft({ action: 'deactivateAfterFailures' }), forbidden)).toEqual([])
  })

  it('refuses a workflow that does not exist, and lets a scope through while the workflows are not known', () => {
    expect(rulesOf(draft({ scopeId: 'wf-gone' }))).toEqual(['scope.unknown_workflow'])
    expect(rulesOf(draft({ scopeId: 'wf-a' }))).toEqual([])
    expect(rulesOf(draft({ scopeId: 'wf-gone' }), { ...ENV, workflowIds: undefined })).toEqual([])
  })

  it('refuses a channel with a space, a control character, a hidden character or too many characters', () => {
    expect(rulesOf(draft({ channel: '#two words' }))).toEqual(['channel.whitespace'])
    expect(rulesOf(draft({ channel: '#a\tb' }))).toEqual(['channel.control_character'])
    expect(rulesOf(draft({ channel: '#a\u202eb' }))).toEqual(['channel.bidi_format'])
    expect(rulesOf(draft({ channel: '#a\u200bb' }))).toEqual(['channel.format_character'])
    expect(rulesOf(draft({ channel: `#${'a'.repeat(80)}` }))).toEqual(['channel.too_long'])
    expect(rulesOf(draft({ channel: '  #alerts  ' }))).toEqual([])
  })

  it('refuses a hook that is already saved, in the spelling that the engine would save, and not the hook that is being edited', () => {
    const saved = [hook('h1', { event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#alerts' } })]
    expect(rulesOf(draft({ channel: '  #alerts ' }), ENV, saved)).toEqual(['hook.duplicate'])
    expect(rulesOf(draft({ channel: '#alerts', enabled: false }), ENV, saved)).toEqual(['hook.duplicate'])
    expect(rulesOf(draft({ channel: '#alerts' }), ENV, saved, 'h1')).toEqual([])
    expect(rulesOf(draft({ channel: '#other' }), ENV, saved)).toEqual([])
    expect(rulesOf(draft({ channel: '#alerts', event: 'run.succeeded' }), ENV, saved)).toEqual([])
    expect(rulesOf(draft({ channel: '#alerts', scopeId: 'wf-a' }), ENV, saved)).toEqual([])
    const counted = [hook('h2', { event: 'run.failed', scope: { type: 'all' }, action: { type: 'deactivateAfterFailures', count: 3 } })]
    expect(rulesOf(draft({ action: 'deactivateAfterFailures', count: '3' }), ENV, counted)).toEqual(['hook.duplicate'])
    expect(rulesOf(draft({ action: 'deactivateAfterFailures', count: '4' }), ENV, counted)).toEqual([])
  })

  it('gives the input that the engine would store when the draft passes', () => {
    const result = checkDraft(draft({ channel: '  #alerts  ' }), ENV, [], undefined)
    expect(result.input).toEqual({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#alerts' }, enabled: true })
    expect(checkDraft(draft({ connection: '' }), ENV, [], undefined).input).toBeUndefined()
  })
})

describe('the rules that forbid a Slack notice', () => {
  const rule = (kind: Rule['kind'], value: string): Rule => ({ id: value, kind, value, createdAt: 1 })

  it('are a forbidNode rule for notify.slack, in any version and any case', () => {
    expect(notifyForbiddenBy([rule('forbidNode', 'notify.slack')])).toBe(true)
    expect(notifyForbiddenBy([rule('forbidNode', 'notify.slack@1')])).toBe(true)
    expect(notifyForbiddenBy([rule('forbidNode', 'Notify.Slack')])).toBe(true)
  })

  it('are not other rules', () => {
    expect(notifyForbiddenBy([])).toBe(false)
    expect(notifyForbiddenBy([rule('forbidNode', 'http.request'), rule('allowHost', 'notify.slack'), rule('maxPlanEffort', 'low')])).toBe(false)
  })
})

describe('the error texts', () => {
  const keyOf = (error: unknown) => hookErrorKey(error)

  it('has a text for each error code of the hook methods', () => {
    expect(keyOf(new RillError('HOOK_FULL', 'x'))).toBe('agents.hooks.error.HOOK_FULL')
    expect(keyOf(new RillError('HOOK_NOT_FOUND', 'x'))).toBe('agents.hooks.error.HOOK_NOT_FOUND')
    expect(keyOf(new RillError('INVALID_PARAMS', 'x'))).toBe('agents.hooks.error.INVALID_PARAMS')
    expect(keyOf(new RillError('HOOK_INVALID', 'x'))).toBe('agents.hooks.error.HOOK_INVALID')
    expect(keyOf(new RillError('INTERNAL', 'x'))).toBe('agents.hooks.error.generic')
    expect(keyOf(new Error('x'))).toBe('agents.hooks.error.generic')
    expect(keyOf('x')).toBe('agents.hooks.error.generic')
    expect(keyOf(new RillError('constructor', 'x'))).toBe('agents.hooks.error.generic')
  })

  it.each(HOOK_RULES)('has a text for the problem line of the rule %s, whatever its field', (rule) => {
    const field = rule === 'only_for_run_failed' || rule === 'forbidden_by_rule' ? 'action' : rule === 'duplicate' ? 'hook' : rule === 'out_of_range' ? 'count' : rule === 'unknown_workflow' ? 'scope' : rule === 'whitespace' ? 'channel' : 'connection'
    const error = new RillError('HOOK_INVALID', 'x', [hookProblemLine({ field, rule })])
    expect(keyOf(error)).toBe(problemKey({ field, rule }))
    expect(keyOf(error)).not.toBe('agents.hooks.error.HOOK_INVALID')
  })

  it('takes the first problem that it can read, and falls back to the general text for a line that it cannot read', () => {
    const lines = ['garbage', hookProblemLine({ field: 'count', rule: 'out_of_range' }), hookProblemLine({ field: 'hook', rule: 'duplicate' })]
    expect(keyOf(new RillError('HOOK_INVALID', 'x', lines))).toBe(problemKey({ field: 'count', rule: 'out_of_range' }))
    expect(keyOf(new RillError('HOOK_INVALID', 'x', ['garbage', 'a.b: c']))).toBe('agents.hooks.error.HOOK_INVALID')
    expect(keyOf(new RillError('HOOK_INVALID', 'x', []))).toBe('agents.hooks.error.HOOK_INVALID')
  })

  it('says on the page, where there is no list to choose from, that a hook cannot be switched on as it is saved, for the problems that only the form can fix', () => {
    for (const key of [problemKey({ field: 'connection', rule: 'unknown_connection' }), problemKey({ field: 'scope', rule: 'unknown_workflow' }), problemKey({ field: 'action', rule: 'forbidden_by_rule' })]) {
      expect(pageErrorKey(key), key).toBe('agents.hooks.error.switchOn')
    }
    for (const key of [problemKey({ field: 'connection', rule: 'not_slack_connection' }), 'agents.hooks.error.HOOK_NOT_FOUND', 'agents.hooks.error.generic'] as const) {
      expect(pageErrorKey(key), key).toBe(key)
    }
    expect(Object.hasOwn(en, 'agents.hooks.error.switchOn')).toBe(true)
    expect(Object.hasOwn(ko, 'agents.hooks.error.switchOn')).toBe(true)
  })

  it('tells a channel that is too long from a connection name that is too long', () => {
    expect(problemKey({ field: 'channel', rule: 'too_long' })).not.toBe(problemKey({ field: 'connection', rule: 'too_long' }))
  })

  it('exist in both languages, for every key that the table can give', () => {
    const rules: HookRule[] = [...HOOK_RULES]
    for (const rule of rules) {
      for (const field of ['connection', 'channel', 'count', 'action', 'scope', 'hook', 'event'] as const) {
        const key = problemKey({ field, rule })
        expect(Object.hasOwn(en, key) || Object.hasOwn(en, `${key}.other`), key).toBe(true)
        expect(Object.hasOwn(ko, key) || Object.hasOwn(ko, `${key}.other`), key).toBe(true)
      }
    }
  })
})
