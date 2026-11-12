import type { ExplainEffort, ExplainResult, RunSummary } from '@rill/protocol'
import { useId, useState } from 'react'
import type { EngineClient } from '../engine/client'
import { useT } from '../i18n'
import { ExplainCard } from './ExplainCard'
import { ExplainNotice } from './ExplainNotice'
import styles from './ExplainPanel.module.css'
import { canExplain } from './model/explain-state'
import { useExplain } from './useExplain'

export interface ExplainPanelProps {
  client: EngineClient
  run: RunSummary | undefined
  model?: { provider: string; model: string }
  onAction(action: ExplainResult['suggestedActions'][number], context: { runId: string; nodeId?: string }): void
  onProposeFix(proposal: { nodeId: string; requestText: string }): void
}

const EFFORTS: readonly ExplainEffort[] = ['low', 'medium', 'high']

export function ExplainPanel({ client, run, model, onAction, onProposeFix }: ExplainPanelProps) {
  const t = useT()
  const reasonId = useId()
  const effortId = useId()
  const { state, open, cancelNotice, send, reset } = useExplain(client, run?.id)
  const [effort, setEffort] = useState<ExplainEffort>('medium')
  const [skipNext, setSkipNext] = useState(false)
  const [accepted, setAccepted] = useState<string | undefined>(undefined)
  const target = model === undefined ? '' : `${model.provider}\u0000${model.model}`
  const allowed = canExplain(run)

  const ask = (): void => {
    if (accepted === target) {
      send(effort)
      return
    }
    setSkipNext(false)
    open(effort)
  }

  const confirm = (): void => {
    if (skipNext) setAccepted(target)
    send(state.phase === 'confirming' ? state.effort : effort)
  }

  const reason = run === undefined ? t('explain.reason.none') : run.status === 'failed' ? undefined : t(`explain.reason.${run.status}`)

  const row = (askLabel: string, extra?: React.ReactNode) => (
    <div className={styles.row}>
      <div className={styles.field}>
        <label htmlFor={effortId} className={styles.label}>
          {t('explain.effort.label')}
        </label>
        <select id={effortId} className={styles.select} value={effort} onChange={(event) => setEffort(event.target.value as ExplainEffort)}>
          {EFFORTS.map((value) => (
            <option key={value} value={value}>
              {t(`explain.effort.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className={styles.primary} disabled={!allowed} aria-describedby={reason === undefined ? undefined : reasonId} onClick={ask}>
        {askLabel}
      </button>
      {extra}
    </div>
  )

  return (
    <section className={styles.root} aria-label={t('explain.heading')}>
      {state.phase === 'idle' && (
        <>
          {row(t('explain.ask'))}
          {reason !== undefined && (
            <p id={reasonId} className={styles.reason}>
              {reason}
            </p>
          )}
        </>
      )}
      {state.phase === 'confirming' && (
        <ExplainNotice model={model} effort={state.effort} skipNext={skipNext} onSkipNextChange={setSkipNext} onSend={confirm} onCancel={cancelNotice} />
      )}
      {state.phase === 'asking' && (
        <div className={styles.asking}>
          <p role="status" className={styles.progress}>
            {t('explain.progress')}
          </p>
          <p className={styles.reason}>{t('explain.dismissWarning')}</p>
          <div>
            <button type="button" className={styles.button} onClick={reset}>
              {t('explain.dismiss')}
            </button>
          </div>
        </div>
      )}
      {state.phase === 'error' && (
        <div className={styles.asking}>
          <p role="alert" className={styles.error}>
            {t(state.key)}
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.primary} onClick={() => send(effort)}>
              {t('explain.retry')}
            </button>
            <button type="button" className={styles.button} onClick={reset}>
              {t('explain.dismiss')}
            </button>
          </div>
        </div>
      )}
      {state.phase === 'done' && (
        <>
          <ExplainCard result={state.result} onAction={onAction} onProposeFix={onProposeFix} />
          <div className={styles.buttons}>
            <button type="button" className={styles.button} disabled={!allowed} onClick={ask}>
              {t('explain.askAgain')}
            </button>
            <button type="button" className={styles.button} onClick={reset}>
              {t('explain.dismiss')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
