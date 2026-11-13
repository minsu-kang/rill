import type { Ref } from 'react'
import { useT } from '../i18n'
import type { ConnectionState } from './connection'
import controls from './controls.module.css'
import type { PingState } from './glue/usePing'
import { Logo } from './Logo'
import styles from './TopBar.module.css'

export type AppTab = 'workflows' | 'recipes' | 'agents' | 'settings'
export const APP_TABS: readonly AppTab[] = ['workflows', 'recipes', 'agents', 'settings']

export interface TopBarProps {
  tab: AppTab
  onTab(tab: AppTab): void
  connection: Pick<ConnectionState, 'state' | 'status'>
  ping?: PingState
  onRestart(): void
  restarting?: boolean
  chatOpen: boolean
  onToggleChat(): void
  chatToggleRef?: Ref<HTMLButtonElement>
}

function engineKey(connection: Pick<ConnectionState, 'state' | 'status'>) {
  if (connection.state === 'no_host') return 'app.top.engine.noHost' as const
  if (connection.state === 'engine_stopped') return 'app.top.engine.stopped' as const
  if (connection.status?.state === 'restarting') return 'app.top.engine.restarting' as const
  if (connection.state === 'connected') return 'app.top.engine.connected' as const
  return connection.state === 'reconnecting' ? ('app.top.engine.reconnecting' as const) : ('app.top.engine.connecting' as const)
}

export function TopBar({ tab, onTab, connection, ping, onRestart, restarting = false, chatOpen, onToggleChat, chatToggleRef }: TopBarProps) {
  const t = useT()
  const stopped = connection.state === 'engine_stopped'
  const reason = connection.status?.error
  const key = engineKey(connection)
  const connected = key === 'app.top.engine.connected'
  const label = t(key)
  return (
    <header className={styles.bar} data-rill-region="topbar" aria-label={t('app.region.top')}>
      <strong className={styles.brand}>
        <Logo size={24} />
        <span>{t('app.name')}</span>
      </strong>
      <nav className={styles.tabs} aria-label={t('app.top.screens')}>
        {APP_TABS.map((value) => (
          <button key={value} type="button" className={styles.tab} aria-current={value === tab ? 'page' : undefined} onClick={() => onTab(value)}>
            {t(`app.tab.${value}`)}
          </button>
        ))}
      </nav>
      <div className={styles.status}>
        <span
          className={connected ? styles.indicator : styles.chip}
          role="status"
          aria-live="polite"
          data-state={connection.state}
          {...(connected ? { title: label } : { 'data-rill-chip': '' })}
          {...(ping === undefined ? {} : { 'data-rill-ping': ping.state })}
          {...(ping?.ms === undefined ? {} : { 'data-rill-ping-ms': ping.ms })}
        >
          {connected ? (
            <>
              <span className={styles.dot} data-rill-dot="" aria-hidden="true" />
              <span className={styles.visuallyHidden}>{label}</span>
            </>
          ) : (
            label
          )}
        </span>
        {stopped ? (
          <>
            {reason === undefined ? null : <span className={controls.note}>{t(`app.engine.error.${reason}`)}</span>}
            <button type="button" className={controls.button} disabled={restarting} onClick={onRestart}>
              {t('app.top.engine.restart')}
            </button>
          </>
        ) : null}
        <button type="button" ref={chatToggleRef} className={styles.chatToggle} aria-expanded={chatOpen} onClick={onToggleChat}>
          {t(chatOpen ? 'app.top.chat.close' : 'app.top.chat.open')}
        </button>
      </div>
    </header>
  )
}
