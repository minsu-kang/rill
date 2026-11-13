import { HOOK_MAX_ITEMS, type Hook } from '@rill/protocol'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { plainText } from '../../chat/model/clamp'
import { errorCodeOf } from '../../engine/agents'
import type { EngineClient } from '../../engine/client'
import { useHookStore } from '../../engine/hook-store'
import { useRules } from '../../engine/rules'
import { useT, type MessageKey } from '../../i18n'
import { truncate } from '../../model/text'
import type { ConnectionSummary } from '../../shared/host-api'
import { SafeText } from '../../ui/SafeText'
import { TransferIcon } from '../../ui/TransferMark'
import visuallyHidden from '../../ui/visuallyHidden.module.css'
import controls from '../controls.module.css'
import { useAction } from '../settings/useAction'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import { HookActivity } from './HookActivity'
import { HookEditor, say } from './HookEditor'
import styles from './HooksScreen.module.css'
import { NEW_HOOK_DRAFT, checkDraft, draftOf, hookErrorKey, hookLabels, inputOfHook, notifyForbiddenBy, sameDraft, type HookDraft, type HookEnv } from './model/hooks'
import { useWorkflowList } from '../workflows/useWorkflowList'

export interface HooksScreenProps {
  client: EngineClient
  connections?: readonly ConnectionSummary[] | undefined
  onOpenConnections?(): void
  timeZone?: string
}

interface EditorState {
  id: string | undefined
  base: HookDraft
  draft: HookDraft
}

type Asking = { kind: 'delete'; hook: Hook } | { kind: 'discard'; then(): void }

type Focus = { kind: 'editor' } | { kind: 'edit'; id: string } | { kind: 'new' } | { kind: 'list' }

const VISIBLE_CHARS = 80
const SUMMARY_CHARS = 60

function findFocus(container: HTMLElement, target: Focus): HTMLElement | null {
  switch (target.kind) {
    case 'editor':
      return container.querySelector<HTMLElement>('[data-hook-editor-title]')
    case 'new':
      return container.querySelector<HTMLElement>('[data-hook-new]')
    case 'list':
      return container.querySelector<HTMLElement>('[data-hook-list-title]')
    case 'edit':
      return [...container.querySelectorAll<HTMLElement>('[data-hook-edit]')].find((button) => button.dataset.hookEdit === target.id) ?? null
  }
}

export function HooksScreen({ client, connections, onOpenConnections, timeZone }: HooksScreenProps) {
  const t = useT()
  const { state, store } = useHookStore(client)
  const workflowList = useWorkflowList(client)
  const { state: rules } = useRules(client)
  const action = useAction(hookErrorKey)
  const [editor, setEditor] = useState<EditorState | undefined>(undefined)
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  const [status, setStatus] = useState<MessageKey | undefined>(undefined)
  const [origin, setOrigin] = useState<'page' | 'editor'>('page')
  const root = useRef<HTMLElement>(null)
  const pendingFocus = useRef<Focus | undefined>(undefined)
  const titleId = useId()
  const listTitleId = useId()
  const rowId = useId()

  useEffect(() => {
    void store.refreshLog()
  }, [store])

  useEffect(() => {
    const target = pendingFocus.current
    const container = root.current
    if (target === undefined || container === null) return
    const element = findFocus(container, target)
    if (element === null) {
      pendingFocus.current = undefined
      return
    }
    if (element instanceof HTMLButtonElement && element.disabled) return
    pendingFocus.current = undefined
    element.focus()
  })

  const names = useMemo(() => new Map(workflowList.workflows.map((workflow) => [workflow.id, workflow.name])), [workflowList.workflows])
  const visible = useMemo(() => hookLabels(t, names, (text) => truncate(text, VISIBLE_CHARS)), [t, names])
  const plain = useMemo(() => hookLabels(t, names, (text) => plainText(text, SUMMARY_CHARS)), [t, names])
  const notifyForbidden = notifyForbiddenBy(rules.rules)
  const env: HookEnv = useMemo(
    () => ({ workflowIds: workflowList.status === 'ready' ? new Set(workflowList.workflows.map((workflow) => workflow.id)) : undefined, connections, notifyForbidden }),
    [workflowList.status, workflowList.workflows, connections, notifyForbidden],
  )

  const ready = state.loaded || state.hooks.length > 0
  const full = state.hooks.length >= HOOK_MAX_ITEMS
  const open = editor !== undefined && (editor.id === undefined || state.hooks.some((hook) => hook.id === editor.id)) ? editor : undefined
  const dirty = open !== undefined && !sameDraft(open.draft, open.base)
  const check = useMemo(() => (open === undefined ? undefined : checkDraft(open.draft, env, state.hooks, open.id)), [open, env, state.hooks])
  const slackNames = useMemo(() => (connections === undefined ? undefined : new Set(connections.filter((entry) => entry.kind === 'slack').map((entry) => entry.name))), [connections])

  const dialogError = asking?.kind === 'delete' ? action.error : undefined
  const editorError = asking === undefined && open !== undefined && origin === 'editor' ? action.error : undefined
  const pageError = asking === undefined && !(open !== undefined && origin === 'editor') ? action.error : undefined

  function begin(next: { id?: string; draft: HookDraft }): void {
    action.clearError()
    setStatus(undefined)
    setOrigin('editor')
    setEditor({ id: next.id, base: next.draft, draft: next.draft })
    pendingFocus.current = { kind: 'editor' }
  }

  function guarded(next: () => void): void {
    if (dirty) setAsking({ kind: 'discard', then: next })
    else next()
  }

  function startNew(): void {
    if (!full) guarded(() => begin({ draft: NEW_HOOK_DRAFT }))
  }

  function startEdit(hook: Hook): void {
    if (open?.id === hook.id) {
      pendingFocus.current = { kind: 'editor' }
      return
    }
    guarded(() => begin({ id: hook.id, draft: draftOf(hook) }))
  }

  function change(patch: Partial<HookDraft>): void {
    action.clearError()
    setStatus(undefined)
    setEditor((current) => (current === undefined ? current : { ...current, draft: { ...current.draft, ...patch } }))
  }

  function cancel(): void {
    const id = open?.id
    action.clearError()
    setEditor(undefined)
    pendingFocus.current = id === undefined ? { kind: 'new' } : { kind: 'edit', id }
  }

  function save(): void {
    if (open === undefined || check?.input === undefined) return
    const { id } = open
    const input = check.input
    setOrigin('editor')
    setStatus(undefined)
    void action.run(async () => {
      try {
        const hook = await store.save(id === undefined ? input : { ...input, id })
        setEditor(undefined)
        setStatus(id === undefined ? 'agents.hooks.status.created' : 'agents.hooks.status.saved')
        pendingFocus.current = { kind: 'edit', id: hook.id }
      } catch (error) {
        if (id !== undefined && errorCodeOf(error) === 'HOOK_NOT_FOUND') {
          setEditor(undefined)
          setOrigin('page')
        }
        throw error
      }
    })
  }

  function toggle(hook: Hook): void {
    setOrigin('page')
    setStatus(undefined)
    void action.run(async () => {
      await store.save({ ...inputOfHook(hook), id: hook.id, enabled: !hook.enabled })
      setStatus(hook.enabled ? 'agents.hooks.status.switchedOff' : 'agents.hooks.status.switchedOn')
    })
  }

  function askDelete(hook: Hook): void {
    setOrigin('page')
    setStatus(undefined)
    action.clearError()
    setAsking({ kind: 'delete', hook })
  }

  function confirmDelete(): void {
    if (asking?.kind !== 'delete') return
    const { hook } = asking
    setOrigin('page')
    void action.run(async () => {
      await store.remove(hook.id)
      setAsking(undefined)
      setStatus('agents.hooks.status.deleted')
      pendingFocus.current = { kind: 'list' }
    })
  }

  function connectionGone(hook: Hook): boolean {
    const { action: what } = hook
    return what.type === 'notify' && slackNames !== undefined && !slackNames.has(what.connection)
  }

  return (
    <section ref={root} className={styles.root} aria-labelledby={titleId}>
      <header className={styles.head}>
        <h2 id={titleId} className={visuallyHidden.hidden}>
          {t('agents.hooks.screen.title')}
        </h2>
        <p className={controls.note}>{t('agents.hooks.screen.intro')}</p>
        <p className={controls.note}>{t('agents.hooks.screen.engine')}</p>
        <p className={`${controls.note} ${styles.transfer}`}>
          <TransferIcon />
          <span>{t('agents.hooks.screen.transfer')}</span>
        </p>
      </header>
      {state.status === 'loading' && !ready ? (
        <p className={controls.note} role="status">
          {t('agents.hooks.screen.loading')}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className={styles.loadError}>
          <p className={controls.error} role="alert">
            {t(ready ? 'agents.hooks.screen.staleError' : 'agents.hooks.screen.loadError')}
          </p>
          <div className={controls.row}>
            <button type="button" className={controls.button} onClick={() => void store.refresh()}>
              {t('agents.hooks.screen.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {ready ? (
        <div className={styles.body}>
          <div className={styles.summary}>
            <span className={styles.count}>{t('agents.hooks.count', { count: state.hooks.length, max: HOOK_MAX_ITEMS })}</span>
            <button type="button" className={controls.primary} data-hook-new="" disabled={full || action.busy} onClick={startNew}>
              {t('agents.hooks.new')}
            </button>
          </div>
          {full ? (
            <p className={controls.warn} role="note">
              {t('agents.hooks.full', { max: HOOK_MAX_ITEMS })}
            </p>
          ) : null}
          <div role="status">{status === undefined ? null : <p className={controls.ok}>{t(status)}</p>}</div>
          {pageError === undefined ? null : (
            <p className={controls.error} role="alert">
              {say(t, pageError)}
            </p>
          )}
          {open !== undefined && check !== undefined ? (
            <HookEditor
              creating={open.id === undefined}
              draft={open.draft}
              dirty={dirty}
              check={check}
              workflows={{ status: workflowList.status, items: workflowList.workflows }}
              connections={connections}
              busy={action.busy}
              error={editorError}
              onChange={change}
              onSave={save}
              onCancel={cancel}
              {...(onOpenConnections === undefined ? {} : { onOpenConnections })}
            />
          ) : null}
          <section className={styles.group} aria-labelledby={listTitleId}>
            <h3 id={listTitleId} tabIndex={-1} className={styles.groupTitle} data-hook-list-title="">
              {t('agents.hooks.list.title')}
            </h3>
            {state.hooks.length === 0 ? (
              <p className={controls.note}>{t('agents.hooks.list.empty')}</p>
            ) : (
              <ul className={styles.list}>
                {state.hooks.map((hook) => {
                  const summary = plain.summary(hook)
                  const editing = open?.id === hook.id
                  const blocked = hook.action.type === 'notify' && notifyForbidden
                  const gone = connectionGone(hook)
                  const noteId = `${rowId}-${hook.id}-note`
                  const noted = blocked || gone
                  return (
                    <li key={hook.id} className={styles.row} data-hook-id={hook.id}>
                      <div className={styles.rowMain}>
                        <p className={styles.rowTitle}>
                          <span className={styles.event}>{visible.event(hook.event)}</span>
                          <span className={styles.muted}>
                            {' · '}
                            <SafeText text={visible.scope(hook.scope)} />
                          </span>
                        </p>
                        <p className={styles.rowAction}>
                          <SafeText text={visible.action(hook.action)} />
                        </p>
                        {noted ? (
                          <div id={noteId} className={styles.rowNotes}>
                            {blocked ? <p className={controls.warn}>{t('agents.hooks.row.blockedByRule')}</p> : null}
                            {gone && hook.action.type === 'notify' ? (
                              <p className={controls.warn}>
                                <SafeText text={t('agents.hooks.row.connectionGone', { name: truncate(hook.action.connection, VISIBLE_CHARS) })} />
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className={styles.rowControls}>
                        <label className={styles.switch}>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={hook.enabled}
                            disabled={action.busy || editing || (!hook.enabled && noted)}
                            aria-label={t('agents.hooks.row.switchLabel', { summary })}
                            aria-describedby={noted ? noteId : undefined}
                            onChange={() => toggle(hook)}
                          />
                          <span>{t(hook.enabled ? 'agents.hooks.row.on' : 'agents.hooks.row.off')}</span>
                        </label>
                        <button type="button" className={controls.button} data-hook-edit={hook.id} disabled={action.busy} aria-label={t('agents.hooks.row.editLabel', { summary })} onClick={() => startEdit(hook)}>
                          {t('agents.hooks.row.edit')}
                        </button>
                        <button type="button" className={controls.danger} data-hook-delete={hook.id} disabled={action.busy} aria-label={t('agents.hooks.row.deleteLabel', { summary })} onClick={() => askDelete(hook)}>
                          {t('agents.hooks.row.delete')}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          <HookActivity log={state.log} hooks={state.hooks} visible={visible} names={names} clip={(text) => truncate(text, VISIBLE_CHARS)} {...(timeZone === undefined ? {} : { timeZone })} onRefresh={() => void store.refreshLog()} />
        </div>
      ) : null}
      {asking?.kind === 'discard' ? (
        <ConfirmDialog
          title={t('agents.hooks.unsaved.title')}
          message={t('agents.hooks.unsaved.message')}
          confirmLabel={t('agents.hooks.unsaved.confirm')}
          cancelLabel={t('agents.hooks.unsaved.cancel')}
          danger
          onConfirm={() => {
            const next = asking.then
            setAsking(undefined)
            next()
          }}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
      {asking?.kind === 'delete' ? (
        <ConfirmDialog
          title={t('agents.hooks.delete.title')}
          message={t('agents.hooks.delete.message', { summary: plain.summary(asking.hook) })}
          details={<p className={controls.note}>{t('agents.hooks.delete.note')}</p>}
          confirmLabel={t('agents.hooks.delete.confirm')}
          cancelLabel={t('agents.hooks.delete.cancel')}
          danger
          busy={action.busy}
          error={dialogError === undefined ? undefined : say(t, dialogError)}
          onConfirm={confirmDelete}
          onCancel={() => {
            action.clearError()
            setAsking(undefined)
          }}
        />
      ) : null}
    </section>
  )
}
