import type { ExplainResult } from '@rill/protocol'
import { useId, useState } from 'react'
import { useT } from '../i18n'
import styles from './ActionButtons.module.css'
import { actionKey, isStateChanging } from './model/labels'

type Action = ExplainResult['suggestedActions'][number]

export interface ActionButtonsProps {
  actions: readonly Action[]
  runId: string
  nodeId?: string
  onAction(action: Action, context: { runId: string; nodeId?: string }): void
}

export const MAX_ACTIONS = 3

export function ActionButtons({ actions, runId, nodeId, onAction }: ActionButtonsProps) {
  const t = useT()
  const labelId = useId()
  const [pending, setPending] = useState<Action | undefined>(undefined)
  const shown = actions.filter((action) => action !== 'none').slice(0, MAX_ACTIONS)
  if (shown.length === 0) return null
  const context = nodeId === undefined ? { runId } : { runId, nodeId }

  const choose = (action: Action): void => {
    if (isStateChanging(action)) setPending(action)
    else onAction(action, context)
  }

  return (
    <div className={styles.root} role="group" aria-labelledby={labelId}>
      <h4 id={labelId} className={styles.heading}>
        {t('explain.card.actions')}
      </h4>
      <div className={styles.buttons}>
        {shown.map((action) => (
          <button key={action} type="button" className={styles.button} aria-pressed={pending === action ? true : undefined} onClick={() => choose(action)}>
            {t(actionKey(action))}
          </button>
        ))}
      </div>
      {shown.includes('wait_and_retry') && <p className={styles.hint}>{t('explain.hint.wait_and_retry')}</p>}
      {pending !== undefined && (
        <div className={styles.confirm} role="alert">
          <p className={styles.question}>{t(pending === 'retry_run' ? 'explain.confirm.retry_run' : 'explain.confirm.deactivate_workflow')}</p>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                setPending(undefined)
                onAction(pending, context)
              }}
            >
              {t('explain.confirm.yes')}
            </button>
            <button type="button" className={styles.button} onClick={() => setPending(undefined)}>
              {t('explain.confirm.no')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
