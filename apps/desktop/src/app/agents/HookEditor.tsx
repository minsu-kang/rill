import { HOOK_CHANNEL_MAX_CHARS, HOOK_CONNECTION_MAX_CHARS, HOOK_EVENTS, HOOK_FAILURE_COUNT_MAX, HOOK_FAILURE_COUNT_MIN, HOOK_MAX_ITEMS, HOOK_WORKFLOW_LABEL_MAX_CHARS, hookMessage, type HookActionType, type HookEvent, type HookProblem, type WorkflowSummary } from '@rill/protocol'
import { useId, type FormEvent, type RefCallback } from 'react'
import { plainText } from '../../chat/model/clamp'
import { useT, type MessageKey, type Translate } from '../../i18n'
import type { ConnectionSummary } from '../../shared/host-api'
import controls from '../controls.module.css'
import styles from './HooksScreen.module.css'
import { problemKey, type DraftCheck, type HookDraft } from './model/hooks'

export interface HookEditorProps {
  creating: boolean
  draft: HookDraft
  dirty: boolean
  check: DraftCheck
  workflows: { status: 'loading' | 'ready' | 'error'; items: readonly WorkflowSummary[] }
  connections: readonly ConnectionSummary[] | undefined
  busy: boolean
  error: MessageKey | undefined
  headingRef?: RefCallback<HTMLElement>
  onChange(patch: Partial<HookDraft>): void
  onSave(): void
  onCancel(): void
  onOpenConnections?(): void
}

const ACTIONS: ReadonlyArray<{ type: HookActionType; label: MessageKey }> = [
  { type: 'notify', label: 'agents.hooks.editor.action.notify' },
  { type: 'deactivateAfterFailures', label: 'agents.hooks.editor.action.deactivate' },
  { type: 'record', label: 'agents.hooks.editor.action.record' },
]

export function say(t: Translate, key: MessageKey): string {
  return t(key, {
    max: HOOK_MAX_ITEMS,
    channelMax: HOOK_CHANNEL_MAX_CHARS,
    connectionMax: HOOK_CONNECTION_MAX_CHARS,
    minCount: HOOK_FAILURE_COUNT_MIN,
    maxCount: HOOK_FAILURE_COUNT_MAX,
  })
}

function problemText(t: Translate, problem: HookProblem): string {
  return say(t, problemKey(problem))
}

function previewOf(event: HookEvent, name: string | undefined): string {
  return name === undefined ? hookMessage(event, 'NAME').replace('NAME', '<name>') : hookMessage(event, name)
}

export function HookEditor({ creating, draft, dirty, check, workflows, connections, busy, error, headingRef, onChange, onSave, onCancel, onOpenConnections }: HookEditorProps) {
  const t = useT()
  const id = useId()
  const ids = {
    title: `${id}-title`,
    event: `${id}-event`,
    eventHint: `${id}-event-hint`,
    scope: `${id}-scope`,
    scopeNote: `${id}-scope-note`,
    scopeProblem: `${id}-scope-problem`,
    action: `${id}-action`,
    actionHint: `${id}-action-hint`,
    actionProblem: `${id}-action-problem`,
    connection: `${id}-connection`,
    connectionNote: `${id}-connection-note`,
    connectionProblem: `${id}-connection-problem`,
    channel: `${id}-channel`,
    channelHint: `${id}-channel-hint`,
    channelProblem: `${id}-channel-problem`,
    count: `${id}-count`,
    countHint: `${id}-count-hint`,
    countProblem: `${id}-count-problem`,
    preview: `${id}-preview`,
    hookProblem: `${id}-hook-problem`,
  }
  const problemOf = (field: HookProblem['field']): HookProblem | undefined => check.problems.find((problem) => problem.field === field)
  const connectionProblem = problemOf('connection')
  const showConnectionProblem = connectionProblem !== undefined && connectionProblem.rule !== 'empty'
  const scopeProblem = problemOf('scope')
  const actionProblem = problemOf('action')
  const countProblem = problemOf('count')
  const channelProblem = problemOf('channel')
  const hookProblem = problemOf('hook')
  const describedBy = (...parts: Array<string | undefined>): string | undefined => {
    const joined = parts.filter((part) => part !== undefined).join(' ')
    return joined === '' ? undefined : joined
  }

  const switchOff = draft.action === 'deactivateAfterFailures'
  const slack = connections?.filter((entry) => entry.kind === 'slack')
  const picked = slack?.find((entry) => entry.name === draft.connection)
  const connectionKnown = picked !== undefined
  const connectionNote = slack === undefined || slack.length === 0 || connectionProblem?.rule === 'empty'
  const channelTyped = draft.channel.trim() !== ''
  const channelWarning: MessageKey | undefined =
    picked === undefined ? undefined : picked.slack === undefined ? (channelTyped ? 'agents.hooks.editor.channel.webhook' : undefined) : !channelTyped && picked.slack.channel === undefined ? 'agents.hooks.editor.channel.noDefault' : undefined
  const scopeKnown = draft.scopeId === '' || workflows.items.some((item) => item.id === draft.scopeId)
  const scopeName = draft.scopeId === '' ? undefined : workflows.items.find((item) => item.id === draft.scopeId)?.name
  const canSave = check.canSave && (creating || dirty) && !busy

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (canSave) onSave()
  }

  return (
    <section className={styles.editor} aria-labelledby={ids.title}>
      <h3 id={ids.title} ref={headingRef} tabIndex={-1} className={styles.groupTitle} data-hook-editor-title="">
        {t(creating ? 'agents.hooks.editor.newTitle' : 'agents.hooks.editor.editTitle')}
      </h3>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor={ids.event} className={styles.label}>
            {t('agents.hooks.editor.event')}
          </label>
          <select id={ids.event} data-hook-field="event" className={controls.input} value={draft.event} disabled={busy} aria-describedby={describedBy(ids.eventHint, ids.actionHint)} onChange={(event) => onChange({ event: event.target.value as HookEvent })}>
            {HOOK_EVENTS.map((value) => (
              <option key={value} value={value} disabled={switchOff && value !== 'run.failed'}>
                {t(`agents.hooks.event.${value}`)}
              </option>
            ))}
          </select>
          <p id={ids.eventHint} className={styles.hint}>
            {t('agents.hooks.editor.event.hint')}
          </p>
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.scope} className={styles.label}>
            {t('agents.hooks.editor.scope')}
          </label>
          <select
            id={ids.scope}
            data-hook-field="scope"
            className={controls.input}
            value={draft.scopeId}
            disabled={busy}
            aria-invalid={scopeProblem === undefined ? undefined : 'true'}
            aria-describedby={describedBy(workflows.status === 'ready' ? undefined : ids.scopeNote, scopeProblem === undefined ? undefined : ids.scopeProblem)}
            onChange={(event) => onChange({ scopeId: event.target.value })}
          >
            <option value="">{t('agents.hooks.scope.all')}</option>
            {workflows.items.map((item) => (
              <option key={item.id} value={item.id}>
                {plainText(item.name, 60)}
              </option>
            ))}
            {scopeKnown ? null : <option value={draft.scopeId}>{t('agents.hooks.scope.unknown')}</option>}
          </select>
          {workflows.status === 'ready' ? null : (
            <p id={ids.scopeNote} className={workflows.status === 'error' ? controls.error : styles.hint}>
              {t(workflows.status === 'error' ? 'agents.hooks.editor.scope.error' : 'agents.hooks.editor.scope.loading')}
            </p>
          )}
          {scopeProblem === undefined ? null : (
            <p id={ids.scopeProblem} className={controls.error}>
              {problemText(t, scopeProblem)}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.action} className={styles.label}>
            {t('agents.hooks.editor.action')}
          </label>
          <select
            id={ids.action}
            data-hook-field="action"
            className={controls.input}
            value={draft.action}
            disabled={busy}
            aria-invalid={actionProblem === undefined ? undefined : 'true'}
            aria-describedby={describedBy(ids.actionHint, actionProblem === undefined ? undefined : ids.actionProblem)}
            onChange={(event) => onChange({ action: event.target.value as HookActionType })}
          >
            {ACTIONS.map((entry) => (
              <option key={entry.type} value={entry.type} disabled={entry.type === 'deactivateAfterFailures' && draft.event !== 'run.failed'}>
                {t(entry.label)}
              </option>
            ))}
          </select>
          <p id={ids.actionHint} className={styles.hint}>
            {t('agents.hooks.editor.action.hint')}
          </p>
          {actionProblem === undefined ? null : (
            <p id={ids.actionProblem} className={controls.error}>
              {problemText(t, actionProblem)}
            </p>
          )}
        </div>

        {draft.action === 'notify' ? (
          <>
            <div className={styles.field}>
              <label htmlFor={ids.connection} className={styles.label}>
                {t('agents.hooks.editor.connection')}
              </label>
              <select
                id={ids.connection}
                data-hook-field="connection"
                className={controls.input}
                value={draft.connection}
                disabled={busy || slack === undefined || slack.length === 0}
                aria-invalid={showConnectionProblem ? 'true' : undefined}
                aria-describedby={describedBy(connectionNote ? ids.connectionNote : undefined, showConnectionProblem ? ids.connectionProblem : undefined)}
                onChange={(event) => onChange({ connection: event.target.value })}
              >
                <option value="">{t('agents.hooks.editor.connection.placeholder')}</option>
                {slack?.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {plainText(entry.name, 60)}
                  </option>
                ))}
                {draft.connection === '' || connectionKnown ? null : <option value={draft.connection}>{slack === undefined ? plainText(draft.connection, 60) : t('agents.hooks.editor.connection.missing', { name: plainText(draft.connection, 60) })}</option>}
              </select>
              {slack === undefined ? (
                <p id={ids.connectionNote} className={styles.hint}>
                  {t('agents.hooks.editor.connection.loading')}
                </p>
              ) : slack.length === 0 ? (
                <div id={ids.connectionNote} className={styles.inline}>
                  <p className={controls.note}>{t('agents.hooks.editor.connection.none')}</p>
                  {onOpenConnections === undefined ? null : (
                    <button type="button" className={controls.button} onClick={onOpenConnections}>
                      {t('agents.hooks.editor.connection.open')}
                    </button>
                  )}
                </div>
              ) : connectionProblem?.rule === 'empty' ? (
                <p id={ids.connectionNote} className={styles.hint}>
                  {t('agents.hooks.editor.connection.needed')}
                </p>
              ) : null}
              {showConnectionProblem ? (
                <p id={ids.connectionProblem} className={controls.error}>
                  {problemText(t, connectionProblem)}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <label htmlFor={ids.channel} className={styles.label}>
                {t('agents.hooks.editor.channel')}
              </label>
              <input
                id={ids.channel}
                data-hook-field="channel"
                className={controls.input}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('agents.hooks.editor.channel.placeholder')}
                value={draft.channel}
                disabled={busy}
                aria-invalid={channelProblem === undefined ? undefined : 'true'}
                aria-describedby={describedBy(ids.channelHint, channelProblem === undefined ? undefined : ids.channelProblem)}
                onChange={(event) => onChange({ channel: event.target.value })}
              />
              <p id={ids.channelHint} className={styles.hint}>
                {t('agents.hooks.editor.channel.hint')}
              </p>
              {channelProblem === undefined ? null : (
                <p id={ids.channelProblem} className={controls.error}>
                  {problemText(t, channelProblem)}
                </p>
              )}
              {channelWarning === undefined ? null : <p className={controls.warn}>{t(channelWarning)}</p>}
            </div>

            <div role="group" aria-labelledby={ids.preview} className={styles.preview}>
              <span id={ids.preview} className={styles.label}>
                {t('agents.hooks.editor.preview')}
              </span>
              <p className={styles.message}>
                <code>{previewOf(draft.event, scopeName)}</code>
              </p>
              <p className={styles.hint}>{t('agents.hooks.editor.preview.note', { chars: HOOK_WORKFLOW_LABEL_MAX_CHARS })}</p>
            </div>
          </>
        ) : null}

        {switchOff ? (
          <div className={styles.field}>
            <label htmlFor={ids.count} className={styles.label}>
              {t('agents.hooks.editor.count')}
            </label>
            <input
              id={ids.count}
              data-hook-field="count"
              className={`${controls.input} ${styles.number}`}
              type="number"
              inputMode="numeric"
              min={HOOK_FAILURE_COUNT_MIN}
              max={HOOK_FAILURE_COUNT_MAX}
              step={1}
              value={draft.count}
              disabled={busy}
              aria-invalid={countProblem === undefined ? undefined : 'true'}
              aria-describedby={describedBy(ids.countHint, countProblem === undefined ? undefined : ids.countProblem)}
              onChange={(event) => onChange({ count: event.target.value })}
            />
            <p id={ids.countHint} className={styles.hint}>
              {t('agents.hooks.editor.count.hint', { min: HOOK_FAILURE_COUNT_MIN, max: HOOK_FAILURE_COUNT_MAX })}
            </p>
            {countProblem === undefined ? null : (
              <p id={ids.countProblem} className={controls.error}>
                {problemText(t, countProblem)}
              </p>
            )}
          </div>
        ) : null}

        <label className={styles.check}>
          <input type="checkbox" data-hook-field="enabled" checked={draft.enabled} disabled={busy} onChange={(event) => onChange({ enabled: event.target.checked })} />
          <span>{t('agents.hooks.editor.enabled')}</span>
        </label>

        {hookProblem === undefined ? null : (
          <p id={ids.hookProblem} className={controls.error}>
            {problemText(t, hookProblem)}
          </p>
        )}
        {dirty ? <p className={controls.note}>{t('agents.hooks.editor.unsaved')}</p> : null}
        {error === undefined ? null : (
          <p className={controls.error} role="alert">
            {say(t, error)}
          </p>
        )}
        <div className={controls.row}>
          <button type="submit" className={controls.primary} data-hook-save="" disabled={!canSave}>
            {t(creating ? 'agents.hooks.editor.create' : 'agents.hooks.editor.save')}
          </button>
          <button type="button" className={controls.button} data-hook-cancel="" disabled={busy} onClick={onCancel}>
            {t('agents.hooks.editor.cancel')}
          </button>
        </div>
      </form>
    </section>
  )
}
