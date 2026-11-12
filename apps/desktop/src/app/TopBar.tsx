import type { Ref } from 'react'
import { useT } from '../i18n'
import { escapeInvisible, truncate } from '../model/text'
import type { ConnectionState } from './connection'
import controls from './controls.module.css'
import type { PingState } from './glue/usePing'
import { PROVIDER_LABELS } from './settings/providers'
import styles from './TopBar.module.css'
import { WorkflowSwitcher } from './workflows/WorkflowSwitcher'
import type { WorkflowListState } from './workflows/useWorkflowList'
import type { ProviderId } from '../shared/host-api'

export type AppTab = 'workflows' | 'recipes' | 'settings'
export const APP_TABS: readonly AppTab[] = ['workflows', 'recipes', 'settings']

export interface TopBarProps {
  tab: AppTab
  onTab(tab: AppTab): void
  list: Pick<WorkflowListState, 'status' | 'workflows' | 'refresh'>
  selectedId: string | undefined
  onSelectWorkflow(workflowId: string): void
  connection: Pick<ConnectionState, 'state' | 'status'>
  ping?: PingState
  model: { provider: string; model: string } | undefined
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

function providerName(id: string): string {
  return Object.hasOwn(PROVIDER_LABELS, id) ? PROVIDER_LABELS[id as ProviderId] : truncate(escapeInvisible(id), 32)
}

export function TopBar({ tab, onTab, list, selectedId, onSelectWorkflow, connection, ping, model, onRestart, restarting = false, chatOpen, onToggleChat, chatToggleRef }: TopBarProps) {
  const t = useT()
  const stopped = connection.state === 'engine_stopped'
  const reason = connection.status?.error
  return (
    <header className={styles.bar} data-rill-region="topbar" aria-label={t('app.region.top')}>
      <button type="button" ref={chatToggleRef} className={styles.chatToggle} aria-expanded={chatOpen} onClick={onToggleChat}>
        {t(chatOpen ? 'app.top.chat.close' : 'app.top.chat.open')}
      </button>
      <strong className={styles.brand}>{t('app.name')}</strong>
      <div className={styles.switcher}>
        <WorkflowSwitcher list={list} selectedId={selectedId} onSelect={onSelectWorkflow} />
      </div>
      <nav className={styles.tabs} aria-label={t('app.top.screens')}>
        {APP_TABS.map((value) => (
          <button key={value} type="button" className={styles.tab} aria-current={value === tab ? 'page' : undefined} onClick={() => onTab(value)}>
            {t(`app.tab.${value}`)}
          </button>
        ))}
      </nav>
      <div className={styles.status}>
        <span
          className={styles.chip}
          role="status"
          aria-live="polite"
          data-state={connection.state}
          {...(ping === undefined ? {} : { 'data-rill-ping': ping.state })}
          {...(ping?.ms === undefined ? {} : { 'data-rill-ping-ms': ping.ms })}
        >
          {t(engineKey(connection))}
        </span>
        {stopped ? (
          <>
            {reason === undefined ? null : <span className={controls.note}>{t(`app.engine.error.${reason}`)}</span>}
            <button type="button" className={controls.button} disabled={restarting} onClick={onRestart}>
              {t('app.top.engine.restart')}
            </button>
          </>
        ) : null}
        <span className={styles.transfer} title={model === undefined ? t('app.top.transfer.titleNone') : t('app.top.transfer.title', { provider: providerName(model.provider) })}>
          <span className={controls.badge}>{t('badge.externalTransfer')}</span>
          <span className={styles.model}>{model === undefined ? t('app.top.transfer.none') : t('app.top.transfer.model', { provider: providerName(model.provider), model: truncate(escapeInvisible(model.model), 40) })}</span>
        </span>
      </div>
    </header>
  )
}
