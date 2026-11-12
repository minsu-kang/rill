import type { LlmModelsResult, NodeInfo, ProviderId } from '@rill/protocol'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client'
import { useT, type MessageKey } from '../i18n'
import { Composer, type AttachmentPort, type ComposerProps } from './Composer'
import { ErrorNotice } from './ErrorNotice'
import { MemoryPanel } from './MemoryPanel'
import { MessageBubble, UserMessage } from './MessageBubble'
import { MetaLine } from './MetaLine'
import { ModelPicker } from './ModelPicker'
import { PlanResultCard } from './PlanResultCard'
import { QuestionCard } from './QuestionCard'
import { UnsupportedCard } from './UnsupportedCard'
import { ClampedText } from './ClampedText'
import {
  attachmentsInConversation,
  canSubmit,
  conversationReducer,
  initialConversation,
  planParams,
  type AssistantEntry,
  type ConversationEntry,
} from './model/conversation'
import type { EffortHint } from './model/effort'
import { planErrorKey } from './model/errors'
import { activeModelOf } from './model/models'
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
type ModelsState = { status: 'loading' } | { status: 'ready'; models: LlmModelsResult } | { status: 'error' }
type DeployState = { status: 'deploying' } | { status: 'error'; key: MessageKey }

const EXAMPLES = ['chat.panel.example1', 'chat.panel.example2', 'chat.panel.example3'] as const

let counter = 0
function defaultId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  counter += 1
  return random ?? `plan-${Date.now().toString(36)}-${counter}`
}

export function ChatPanel(props: ChatPanelProps) {
  const { client, port, catalog, hints, editContext, newId = defaultId, onDeployed, onSelectModel, onClearEditContext, initialEntries, initialDraft } = props
  const t = useT()
  const [state, dispatch] = useReducer(conversationReducer, undefined, () => ({
    ...initialConversation(),
    entries: [...(initialEntries ?? [])],
    draft: initialDraft ?? '',
    confirmed: Object.fromEntries((initialEntries ?? []).flatMap((entry) => (entry.role === 'assistant' ? [[entry.planId, [] as string[]]] : []))),
  }))
  const [view, setView] = useState<View>('chat')
  const [modelsState, setModelsState] = useState<ModelsState>({ status: 'loading' })
  const [modelsAttempt, setModelsAttempt] = useState(0)
  const [memoryCount, setMemoryCount] = useState(0)
  const [deploys, setDeploys] = useState<Record<string, DeployState>>({})
  const alive = useRef(true)
  const busy = useRef(false)
  const running = useRef<string | undefined>(undefined)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(
    () => () => {
      const planId = running.current
      if (planId !== undefined) client.request('cancelPlan', { planId }).catch(() => undefined)
    },
    [client],
  )

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
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [client, view])

  useEffect(() => {
    const element = log.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [state.entries.length, state.status])

  const models = modelsState.status === 'ready' ? modelsState.models : undefined
  const model = models === undefined ? undefined : activeModelOf(models)
  const noModel = models !== undefined && models.active === null
  const planning = state.status === 'planning'
  const limited = !canSubmit(state.entries, 'message')

  function submitPlan(text: string, answers?: Record<string, string>): void {
    if (busy.current || state.status === 'planning') return
    if (!canSubmit(state.entries, answers === undefined ? 'message' : 'answers')) {
      dispatch({ type: 'submit', text, ...(answers === undefined ? {} : { answers }) })
      return
    }
    const planId = newId()
    const params = planParams(state, { planId, text, ...(answers === undefined ? {} : { answers }), ...(editContext === undefined ? {} : { editContext }) })
    busy.current = true
    running.current = planId
    dispatch({ type: 'submit', text, ...(answers === undefined ? {} : { answers }) })
    client.request('plan', params).then(
      (result) => {
        busy.current = false
        running.current = undefined
        if (alive.current) dispatch({ type: 'planned', planId, result: result.result, meta: result.meta })
      },
      (failure: unknown) => {
        busy.current = false
        running.current = undefined
        if (alive.current) dispatch({ type: 'failed', error: planErrorKey(failure) })
      },
    )
  }

  function send(): void {
    const text = state.draft.trim()
    if (text !== '') submitPlan(text)
  }

  function cancel(): void {
    const planId = running.current
    if (planId !== undefined) client.request('cancelPlan', { planId }).catch(() => undefined)
  }

  function deploy(entry: AssistantEntry): void {
    const confirmed = state.confirmed[entry.planId] ?? []
    if (deploys[entry.planId]?.status === 'deploying') return
    setDeploys((previous) => ({ ...previous, [entry.planId]: { status: 'deploying' } }))
    client.request('deployPlan', { planId: entry.planId, confirmed: [...confirmed] }).then(
      ({ workflowId }) => {
        if (!alive.current) return
        setDeploys((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== entry.planId)))
        dispatch({ type: 'deployed', planId: entry.planId, workflowId })
        onDeployed?.(workflowId)
      },
      (failure: unknown) => {
        if (alive.current) setDeploys((previous) => ({ ...previous, [entry.planId]: { status: 'error', key: planErrorKey(failure) } }))
      },
    )
  }

  function onComposerChange(patch: Parameters<ComposerProps['onChange']>[0]): void {
    if (patch.draft !== undefined) dispatch({ type: 'draft', text: patch.draft })
    if (patch.effort !== undefined) dispatch({ type: 'effort', effort: patch.effort })
    if (patch.useMemory !== undefined) dispatch({ type: 'useMemory', value: patch.useMemory })
    if (patch.attachments !== undefined) {
      const next = patch.attachments
      for (const have of state.attachments) if (!next.some((item) => item.id === have.id)) dispatch({ type: 'detach', id: have.id })
      for (const ref of next) dispatch({ type: 'attach', ref })
    }
  }

  function newChat(): void {
    setDeploys({})
    dispatch({ type: 'newChat' })
  }

  function renderEntry(entry: ConversationEntry, index: number) {
    if (entry.role === 'user') {
      const before = state.entries[index - 1]
      const questions = before?.role === 'assistant' && before.result.kind === 'questions' ? before.result.questions : undefined
      return (
        <MessageBubble key={`user-${index}`} role="user">
          <UserMessage entry={entry} questions={questions} />
        </MessageBubble>
      )
    }
    const { result } = entry
    const isLast = index === state.entries.length - 1
    const deployState = deploys[entry.planId]
    return (
      <MessageBubble key={entry.planId} role="assistant">
        {result.kind === 'workflow' ? (
          <PlanResultCard
            entry={entry}
            catalog={catalog}
            confirmed={state.confirmed[entry.planId] ?? []}
            onToggleFlag={(key) => dispatch({ type: 'toggleFlag', planId: entry.planId, key })}
            onDeploy={() => deploy(entry)}
            deploying={deployState?.status === 'deploying'}
            deployError={deployState?.status === 'error' ? deployState.key : undefined}
          />
        ) : result.kind === 'questions' ? (
          <>
            <p className={styles.summary}>
              <ClampedText text={result.summary} max={300} />
            </p>
            <QuestionCard questions={result.questions} disabled={!isLast || planning} onSubmit={(answers) => submitPlan(t('chat.answers.continue'), answers)} />
          </>
        ) : (
          <UnsupportedCard summary={result.summary} reason={result.reason} nearest={result.nearest} />
        )}
        <MetaLine meta={entry.meta} />
      </MessageBubble>
    )
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
          <button type="button" className={styles.tab} disabled={planning} onClick={newChat}>
            {t('chat.panel.newChat')}
          </button>
        </div>
      </header>
      <div className={styles.view} hidden={view !== 'chat'}>
        <div ref={log} className={styles.log} role="log" aria-label={t('chat.panel.log')}>
          {state.entries.length === 0 && !planning ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{t('chat.panel.empty')}</p>
              <p className={styles.emptyHint}>{t('chat.panel.emptyHint')}</p>
              <div className={styles.examples}>
                {EXAMPLES.map((key) => (
                  <button key={key} type="button" className={styles.example} disabled={noModel} onClick={() => dispatch({ type: 'draft', text: t(key) })}>
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {state.entries.map(renderEntry)}
          {planning ? <div className={styles.thinking}>{t('chat.panel.thinking')}</div> : null}
        </div>
        <div className={styles.bottom}>
          {modelsState.status === 'loading' ? <p className={styles.note}>{t('chat.panel.loadingModels')}</p> : null}
          {modelsState.status === 'error' ? (
            <div className={styles.row}>
              <ErrorNotice messageKey="chat.error.generic" />
              <p className={styles.note}>{t('chat.panel.modelsError')}</p>
              <button
                type="button"
                className={styles.tab}
                onClick={() => {
                  setModelsState({ status: 'loading' })
                  setModelsAttempt((count) => count + 1)
                }}
              >
                {t('chat.panel.retry')}
              </button>
            </div>
          ) : null}
          {noModel ? (
            <div className={styles.noModel}>
              <strong>{t('chat.panel.noModelTitle')}</strong>
              <p className={styles.note}>{t('chat.panel.noModel')}</p>
            </div>
          ) : null}
          {limited ? (
            <div className={styles.row}>
              <ErrorNotice messageKey="chat.error.turnLimit" />
              <button type="button" className={styles.tab} disabled={planning} onClick={newChat}>
                {t('chat.panel.startNew')}
              </button>
            </div>
          ) : state.error === undefined ? null : (
            <ErrorNotice messageKey={state.error} onDismiss={() => dispatch({ type: 'clearError' })} />
          )}
          <Composer
            state={state}
            model={model}
            models={models}
            memoryCount={memoryCount}
            editContext={editContext}
            port={port}
            busy={planning}
            disabled={noModel || limited}
            conversationAttachments={attachmentsInConversation(state.entries)}
            hints={hints}
            onChange={onComposerChange}
            onSend={send}
            onCancel={cancel}
            onClearEditContext={() => onClearEditContext?.()}
          />
        </div>
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
    </section>
  )
}
