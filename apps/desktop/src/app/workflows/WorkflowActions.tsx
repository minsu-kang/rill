import type { NodeInfo, WorkflowSummary } from '@rill/protocol'
import { useEffect, useRef, useState } from 'react'
import type { EngineClient } from '../../engine/client'
import { useT } from '../../i18n'
import { escapeInvisible, truncate } from '../../model/text'
import controls from '../controls.module.css'
import { useAction } from '../settings/useAction'
import { ConfirmDialog } from './ConfirmDialog'
import { PayloadDialog } from './PayloadDialog'
import { SideEffects, useSideEffects } from './SideEffects'
import { engineErrorKey } from './errors'
import { needsPayload, triggerKind } from './samples'
import styles from './Workflows.module.css'

export interface WorkflowActionsProps {
  client: EngineClient
  workflowId: string
  summary: WorkflowSummary
  catalog: readonly NodeInfo[]
  onRunStarted(runId: string): void
  disabled?: boolean
  focusAction?: 'dryRun' | 'activate'
}

type Dialog = { kind: 'payload'; mode: 'dry' | 'live' } | { kind: 'confirmRun'; payload: unknown } | { kind: 'deactivate' }

export function WorkflowActions({ client, workflowId, summary, catalog, onRunStarted, disabled = false, focusAction }: WorkflowActionsProps) {
  const t = useT()
  const action = useAction(engineErrorKey)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const dryRun = useRef<HTMLButtonElement>(null)
  const activate = useRef<HTMLButtonElement>(null)
  const kind = triggerKind(summary.triggerType)
  const manual = kind === 'manual'
  const off = disabled || action.busy
  const errorText = action.error === undefined ? undefined : t(action.error)

  useEffect(() => {
    if (focusAction === 'dryRun') dryRun.current?.focus()
    if (focusAction === 'activate') activate.current?.focus()
  }, [focusAction, workflowId])

  function open(next: Dialog): void {
    action.clearError()
    setDialog(next)
  }

  function close(): void {
    action.clearError()
    setDialog(undefined)
  }

  function start(payload: unknown, dry: boolean): void {
    void action
      .run(async () => {
        const { runId } = await client.request('startRun', { workflowId, payload, dryRun: dry })
        onRunStarted(runId)
      })
      .then((ok) => {
        if (ok) setDialog(undefined)
      })
  }

  function toggle(): void {
    void action
      .run(async () => {
        await client.request(summary.active ? 'deactivate' : 'activate', { workflowId })
      })
      .then((ok) => {
        if (ok) setDialog(undefined)
      })
  }

  return (
    <section className={styles.actions} aria-label={t('app.wf.actions.label')}>
      <div className={styles.head}>
        <h2 className={styles.name}>{escapeInvisible(summary.name)}</h2>
        <span className={summary.active ? controls.chipOk : controls.chip}>{t(summary.active ? 'app.wf.active' : 'app.wf.inactive')}</span>
        <span className={controls.chip}>{kind === 'other' ? truncate(escapeInvisible(summary.triggerType), 24) : t(`app.wf.trigger.${kind}`)}</span>
      </div>
      <div className={controls.row}>
        <button type="button" ref={dryRun} data-action="dryRun" className={controls.button} disabled={off} onClick={() => open({ kind: 'payload', mode: 'dry' })}>
          {t('app.wf.actions.dryRun')}
        </button>
        <button
          type="button"
          data-action="runNow"
          className={controls.button}
          disabled={off}
          onClick={() => (needsPayload(summary.triggerType) ? open({ kind: 'payload', mode: 'live' }) : open({ kind: 'confirmRun', payload: {} }))}
        >
          {t('app.wf.actions.runNow')}
        </button>
        {summary.active ? (
          <button type="button" data-action="deactivate" className={controls.button} disabled={off} onClick={() => open({ kind: 'deactivate' })}>
            {t('app.wf.actions.deactivate')}
          </button>
        ) : (
          <button type="button" ref={activate} data-action="activate" className={controls.primary} disabled={off || manual} onClick={toggle}>
            {t('app.wf.actions.activate')}
          </button>
        )}
      </div>
      {!summary.active ? <p className={controls.note}>{t(manual ? 'app.wf.manualHint' : 'app.wf.hint.dryRunFirst')}</p> : null}
      {dialog === undefined && errorText !== undefined ? (
        <p className={controls.error} role="alert">
          {errorText}
        </p>
      ) : null}
      {dialog?.kind === 'payload' ? (
        <PayloadDialog
          key={dialog.mode}
          triggerType={summary.triggerType}
          mode={dialog.mode}
          busy={action.busy}
          error={errorText}
          onCancel={close}
          onSubmit={(payload) => (dialog.mode === 'dry' ? start(payload, true) : open({ kind: 'confirmRun', payload }))}
        />
      ) : null}
      {dialog?.kind === 'confirmRun' ? <RunConfirm client={client} workflowId={workflowId} catalog={catalog} busy={action.busy} error={errorText} onCancel={close} onConfirm={() => start(dialog.payload, false)} /> : null}
      {dialog?.kind === 'deactivate' ? (
        <ConfirmDialog
          title={t('app.deactivate.title')}
          message={t('app.deactivate.message')}
          confirmLabel={t('app.deactivate.confirm')}
          cancelLabel={t('app.common.cancel')}
          busy={action.busy}
          error={errorText}
          onCancel={close}
          onConfirm={toggle}
        />
      ) : null}
    </section>
  )
}

function RunConfirm({ client, workflowId, catalog, busy, error, onCancel, onConfirm }: { client: EngineClient; workflowId: string; catalog: readonly NodeInfo[]; busy: boolean; error: string | undefined; onCancel(): void; onConfirm(): void }) {
  const t = useT()
  const state = useSideEffects(client, workflowId, catalog)
  return (
    <ConfirmDialog
      title={t('app.run.confirmTitle')}
      message={t('app.run.confirmMessage')}
      details={<SideEffects state={state} />}
      confirmLabel={t('app.run.confirmAction')}
      cancelLabel={t('app.common.cancel')}
      confirmDisabled={state.status !== 'ready'}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
