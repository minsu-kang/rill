import { useEffect, useId, useRef, useState } from 'react'
import { useAgents } from '../engine/agents'
import type { EngineClient } from '../engine/client'
import { useT, type MessageKey } from '../i18n'
import { ErrorNotice } from './ErrorNotice'
import { markHidden, plainText } from './model/clamp'
import { planErrorKey } from './model/errors'
import styles from './AgentPicker.module.css'

export interface AgentPickerProps {
  client: EngineClient
}

const NAME_CAP = 40

export function AgentPicker({ client }: AgentPickerProps) {
  const t = useT()
  const id = useId()
  const { state, store } = useAgents(client)
  const [error, setError] = useState<MessageKey | undefined>(undefined)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function change(value: string): void {
    setError(undefined)
    store.select(value).catch((failure: unknown) => {
      if (alive.current) setError(planErrorKey(failure))
    })
  }

  const label = (agent: { builtin: boolean; name: string }): string => (agent.builtin ? t('agents.default.name') : plainText(agent.name, NAME_CAP))
  const active = state.agents.find((agent) => agent.id === state.activeId)

  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id}>
          {t('agents.picker.label')}
        </label>
        {state.status === 'ready' ? (
          <select id={id} className={styles.select} value={state.activeId} title={active === undefined || active.builtin ? undefined : markHidden(active.name)} onChange={(event) => change(event.target.value)}>
            {state.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {label(agent)}
              </option>
            ))}
          </select>
        ) : state.status === 'loading' ? (
          <span className={styles.note} role="status">
            {t('agents.picker.loading')}
          </span>
        ) : (
          <>
            <span className={styles.note}>{t('agents.picker.loadError')}</span>
            <button type="button" className={styles.retry} onClick={() => void store.refresh()}>
              {t('chat.panel.retry')}
            </button>
          </>
        )}
      </div>
      {error === undefined ? null : <ErrorNotice messageKey={error} onDismiss={() => setError(undefined)} />}
    </div>
  )
}
