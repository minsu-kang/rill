import type { AttachmentRef, NodeInfo } from '@rill/protocol'
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client'
import { useT, type MessageKey } from '../i18n'
import { ClampedText } from './ClampedText'
import { Composer, type AttachmentPort, type ComposerProps } from './Composer'
import { ErrorNotice } from './ErrorNotice'
import { MessageBubble, UserMessage } from './MessageBubble'
import { MetaLine } from './MetaLine'
import { PlanResultCard } from './PlanResultCard'
import { QuestionCard } from './QuestionCard'
import { UnsupportedCard } from './UnsupportedCard'
import {
  attachmentsInConversation,
  canSubmit,
  conversationReducer,
  initialConversation,
  memoryInUse,
  planParams,
  type AssistantEntry,
  type ConversationEntry,
} from './model/conversation'
import type { EffortHint } from './model/effort'
import { planErrorKey } from './model/errors'
import { activeModelOf, type ModelsState } from './model/models'
import styles from './Conversation.module.css'

export interface ConversationStatus {
  firstMessage: string | undefined
  working: boolean
  hasContent: boolean
  answers: number
  failed: boolean
}

export interface ConversationProps {
  client: EngineClient
  port: AttachmentPort
  catalog: readonly NodeInfo[]
  hints?: readonly EffortHint[]
  editContext?: { workflowId: string; nodeId?: string }
  newId(): string
  onDeployed?(workflowId: string): void
  onClearEditContext?(): void
  modelsState: ModelsState
  onRetryModels(): void
  memoryCount: number | undefined
  tabId: string
  panelId: string
  labelledBy: string
  hidden: boolean
  active: boolean
  focusOnMount?: boolean
  canOpenNew: boolean
  onNewChat(): void
  report(tabId: string, status: ConversationStatus): void
  initialEntries?: readonly ConversationEntry[]
  initialDraft?: string
}

type DeployState = { status: 'deploying' } | { status: 'error'; key: MessageKey }

const EXAMPLES = ['chat.panel.example1', 'chat.panel.example2', 'chat.panel.example3'] as const

export function Conversation(props: ConversationProps) {
  const { client, port, catalog, hints, editContext, newId, onDeployed, onClearEditContext, modelsState, onRetryModels, memoryCount, tabId, panelId, labelledBy, hidden, active, canOpenNew, onNewChat, initialEntries, initialDraft } = props
  const t = useT()
  const [state, dispatch] = useReducer(conversationReducer, undefined, () => ({
    ...initialConversation(),
    entries: [...(initialEntries ?? [])],
    draft: initialDraft ?? '',
    confirmed: Object.fromEntries((initialEntries ?? []).flatMap((entry) => (entry.role === 'assistant' ? [[entry.planId, [] as string[]]] : []))),
  }))
  const [deploys, setDeploys] = useState<Record<string, DeployState>>({})
  const alive = useRef(true)
  const busy = useRef(false)
  const running = useRef<string | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const viewed = useRef<{ entries: number; status: string | undefined; top: number }>({ entries: -1, status: undefined, top: 0 })
  const unsent = useRef<readonly AttachmentRef[]>([])
  const portRef = useRef(port)
  const reportRef = useRef(props.report)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useLayoutEffect(() => {
    unsent.current = [...state.attachments, ...(state.unsent?.attachments ?? [])]
    portRef.current = port
    reportRef.current = props.report
  })

  useEffect(
    () => () => {
      const planId = running.current
      if (planId !== undefined) client.request('cancelPlan', { planId }).catch(() => undefined)
    },
    [client],
  )

  useEffect(
    () => () => {
      for (const item of unsent.current) portRef.current.remove?.(item.id)?.catch(() => undefined)
    },
    [],
  )

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.type === 'workflow.deleted') dispatch({ type: 'workflowDeleted', workflowId: event.workflowId })
      }),
    [client],
  )

  useEffect(() => {
    if (props.focusOnMount === true) root.current?.querySelector<HTMLTextAreaElement>('textarea[data-rill-composer]')?.focus()
  }, [props.focusOnMount])

  useEffect(() => {
    const element = log.current
    if (element === null || !active) return
    const seen = viewed.current
    const changed = seen.entries !== state.entries.length || seen.status !== state.status
    viewed.current = { entries: state.entries.length, status: state.status, top: seen.top }
    element.scrollTop = changed ? element.scrollHeight : seen.top
  }, [state.entries.length, state.status, active])

  const firstUser = state.entries.find((entry) => entry.role === 'user')
  const firstMessage = firstUser?.role === 'user' && firstUser.text.trim() !== '' ? firstUser.text : undefined
  const planning = state.status === 'planning'
  const answers = state.entries.filter((entry) => entry.role === 'assistant').length
  const failed = state.error !== undefined
  const hasContent = state.entries.length > 0 || state.draft.trim() !== '' || state.attachments.length > 0 || (state.unsent?.attachments.length ?? 0) > 0 || planning

  useEffect(() => {
    reportRef.current(tabId, { firstMessage, working: planning, hasContent, answers, failed })
  }, [tabId, firstMessage, planning, hasContent, answers, failed])

  const models = modelsState.status === 'ready' ? modelsState.models : undefined
  const model = models === undefined ? undefined : activeModelOf(models)
  const noModel = models !== undefined && models.active === null
  const limited = !canSubmit(state.entries, 'message')
  const latestWorkflow = state.entries.findLastIndex((entry) => entry.role === 'assistant' && entry.result.kind === 'workflow')

  function submitPlan(text: string, answersGiven?: Record<string, string>): void {
    if (busy.current || state.status === 'planning') return
    if (!canSubmit(state.entries, answersGiven === undefined ? 'message' : 'answers')) {
      dispatch({ type: 'submit', text, ...(answersGiven === undefined ? {} : { answers: answersGiven }) })
      return
    }
    const planId = newId()
    const params = planParams({ ...state, useMemory: memoryInUse(state.useMemory, memoryCount) }, { planId, text, ...(answersGiven === undefined ? {} : { answers: answersGiven }), ...(editContext === undefined ? {} : { editContext }) })
    busy.current = true
    running.current = planId
    dispatch({ type: 'submit', text, ...(answersGiven === undefined ? {} : { answers: answersGiven }) })
    client.request('plan', params).then(
      (result) => {
        if (settle(planId) && alive.current) dispatch({ type: 'planned', planId, result: result.result, meta: result.meta })
      },
      (failure: unknown) => {
        if (settle(planId) && alive.current) dispatch({ type: 'failed', error: planErrorKey(failure) })
      },
    )
  }

  function settle(planId: string): boolean {
    if (running.current !== planId) return false
    busy.current = false
    running.current = undefined
    return true
  }

  function send(): void {
    const text = state.draft.trim()
    if (text !== '') submitPlan(text)
  }

  function cancel(): void {
    const planId = running.current
    if (planId === undefined) return
    const cancelled = (): void => {
      if (settle(planId) && alive.current) dispatch({ type: 'failed', error: planErrorKey({ code: 'PLAN_CANCELLED' }) })
    }
    client.request('cancelPlan', { planId }).then(cancelled, cancelled)
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
    const superseded = index < latestWorkflow
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
            superseded={superseded}
            planning={planning}
          />
        ) : result.kind === 'questions' ? (
          <>
            <p className={styles.summary}>
              <ClampedText text={result.summary} max={300} />
            </p>
            <QuestionCard questions={result.questions} disabled={!isLast || planning} onSubmit={(given) => submitPlan(t('chat.answers.continue'), given)} />
          </>
        ) : (
          <UnsupportedCard summary={result.summary} reason={result.reason} nearest={result.nearest} />
        )}
        <MetaLine meta={entry.meta} />
      </MessageBubble>
    )
  }

  return (
    <div ref={root} id={panelId} className={styles.view} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden}>
      <div ref={log} className={styles.log} role="log" aria-label={t('chat.panel.log')} onScroll={(event) => (viewed.current.top = event.currentTarget.scrollTop)}>
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
            <button type="button" className={styles.retry} onClick={onRetryModels}>
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
            <button type="button" className={styles.retry} disabled={!canOpenNew} onClick={onNewChat}>
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
          inactive={!active}
          onChange={onComposerChange}
          onSend={send}
          onCancel={cancel}
          onClearEditContext={() => onClearEditContext?.()}
        />
      </div>
    </div>
  )
}
