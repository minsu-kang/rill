import type { LlmModelsResult, NodeInfo, ProviderId } from '@rill/protocol'
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react'
import { ConfirmDialog } from '../app/workflows/ConfirmDialog'
import type { EngineClient } from '../engine/client'
import { useT } from '../i18n'
import { ChatTabs } from './ChatTabs'
import type { AttachmentPort } from './Composer'
import { Conversation, type ConversationStatus } from './Conversation'
import { MemoryPanel } from './MemoryPanel'
import { ModelPicker } from './ModelPicker'
import { markHidden } from './model/clamp'
import type { ConversationEntry } from './model/conversation'
import type { EffortHint } from './model/effort'
import { activeModelOf, type ModelsState } from './model/models'
import { canOpenTab, initialTabs, tabsReducer } from './model/tabs'
import styles from './ChatPanel.module.css'

export interface ChatPanelProps {
  client: EngineClient
  port: AttachmentPort
  catalog: readonly NodeInfo[]
  hints?: readonly EffortHint[]
  editContext?: { workflowId: string; nodeId?: string }
  newId?(): string
  onDeployed?(workflowId: string): void
  onSelectModel?(choice: { provider: ProviderId; model: string }): void
  onClearEditContext?(): void
  initialEntries?: readonly ConversationEntry[]
  initialDraft?: string
}

type View = 'chat' | 'model' | 'memory'

let counter = 0
function defaultId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  counter += 1
  return random ?? `plan-${Date.now().toString(36)}-${counter}`
}

function providerLabel(models: LlmModelsResult, id: string): string {
  return models.providers.find((provider) => provider.id === id)?.label ?? id
}

export function ChatPanel(props: ChatPanelProps) {
  const { client, port, catalog, hints, editContext, newId = defaultId, onDeployed, onSelectModel, onClearEditContext, initialEntries, initialDraft } = props
  const t = useT()
  const base = useId()
  const [tabs, dispatch] = useReducer(tabsReducer, undefined, initialTabs)
  const firstTab = useRef(tabs.tabs[0]!.id)
  const [view, setView] = useState<View>('chat')
  const [modelsState, setModelsState] = useState<ModelsState>({ status: 'loading' })
  const [modelsAttempt, setModelsAttempt] = useState(0)
  const [memoryCount, setMemoryCount] = useState<number | undefined>(undefined)
  const [closing, setClosing] = useState<string | undefined>(undefined)
  const [focusSignal, setFocusSignal] = useState(0)

  useEffect(() => {
    let live = true
    client.request('llmModels', {}).then(
      (models) => {
        if (live) setModelsState({ status: 'ready', models })
      },
      () => {
        if (live) setModelsState({ status: 'error' })
      },
    )
    return () => {
      live = false
    }
  }, [client, modelsAttempt])

  useEffect(() => {
    if (view !== 'chat') return undefined
    let live = true
    client.request('listMemory', {}).then(
      (result) => {
        if (live) setMemoryCount(result.items.length)
      },
      () => {
        if (live) setMemoryCount(undefined)
      },
    )
    return () => {
      live = false
    }
  }, [client, view])

  const retryModels = useCallback(() => {
    setModelsState({ status: 'loading' })
    setModelsAttempt((count) => count + 1)
  }, [])

  const report = useCallback((id: string, status: ConversationStatus) => dispatch({ type: 'report', id, ...status }), [])
  const open = useCallback(() => dispatch({ type: 'open' }), [])

  const models = modelsState.status === 'ready' ? modelsState.models : undefined
  const model = models === undefined ? undefined : activeModelOf(models)
  const modelText = model === undefined || models === undefined ? '' : t('chat.panel.model', { provider: markHidden(providerLabel(models, model.provider)), model: markHidden(model.label) })
  const tabDomId = (id: string): string => `${base}-tab-${id}`
  const panelDomId = (id: string): string => `${base}-panel-${id}`

  function requestClose(id: string): void {
    const tab = tabs.tabs.find((item) => item.id === id)
    if (tab === undefined) return
    if (tab.hasContent) setClosing(id)
    else finishClose(id)
  }

  function finishClose(id: string): void {
    dispatch({ type: 'close', id })
    setClosing(undefined)
    setFocusSignal((value) => value + 1)
  }

  return (
    <section className={styles.panel} aria-label={t('chat.panel.title')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('chat.panel.title')}</h2>
        <div className={styles.tabs} role="group" aria-label={t('chat.panel.views')}>
          {(['chat', 'model', 'memory'] as const).map((name) => (
            <button key={name} type="button" className={styles.tab} aria-pressed={view === name} onClick={() => setView(name)}>
              {t(name === 'chat' ? 'chat.panel.tabChat' : name === 'model' ? 'chat.panel.tabModel' : 'chat.panel.tabMemory')}
            </button>
          ))}
        </div>
        {model === undefined ? null : view === 'model' ? (
          <span className={styles.modelText}>{modelText}</span>
        ) : (
          <button type="button" className={styles.modelText} title={t('chat.panel.modelOpen')} onClick={() => setView('model')}>
            {modelText}
          </button>
        )}
      </header>
      {view === 'chat' ? (
        <ChatTabs
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          tabDomId={tabDomId}
          panelDomId={panelDomId}
          canOpen={canOpenTab(tabs)}
          focusSignal={focusSignal}
          onActivate={(id) => dispatch({ type: 'activate', id })}
          onClose={requestClose}
          onOpen={open}
        />
      ) : null}
      <div className={styles.conversations} hidden={view !== 'chat'}>
        {tabs.tabs.map((tab) => (
          <Conversation
            key={tab.id}
            client={client}
            port={port}
            catalog={catalog}
            hints={hints}
            editContext={editContext}
            newId={newId}
            onDeployed={onDeployed}
            onClearEditContext={onClearEditContext}
            modelsState={modelsState}
            onRetryModels={retryModels}
            memoryCount={memoryCount}
            tabId={tab.id}
            panelId={panelDomId(tab.id)}
            labelledBy={tabDomId(tab.id)}
            hidden={tab.id !== tabs.activeId}
            active={tab.id === tabs.activeId}
            focusOnMount={tab.id !== firstTab.current}
            canOpenNew={canOpenTab(tabs)}
            onNewChat={open}
            report={report}
            initialEntries={tab.id === firstTab.current ? initialEntries : undefined}
            initialDraft={tab.id === firstTab.current ? initialDraft : undefined}
          />
        ))}
      </div>
      {view === 'model' ? (
        <div className={styles.page}>
          {models === undefined ? <p className={styles.note}>{t('chat.panel.loadingModels')}</p> : <ModelPicker models={models} onSelect={onSelectModel} />}
        </div>
      ) : null}
      {view === 'memory' ? (
        <div className={styles.page}>
          <MemoryPanel client={client} />
        </div>
      ) : null}
      {closing === undefined ? null : (
        <ConfirmDialog
          title={t('chat.tabs.closeTitle')}
          message={t('chat.tabs.closeBody')}
          confirmLabel={t('chat.tabs.closeConfirm')}
          cancelLabel={t('chat.tabs.closeKeep')}
          onConfirm={() => finishClose(closing)}
          onCancel={() => setClosing(undefined)}
        />
      )}
    </section>
  )
}
