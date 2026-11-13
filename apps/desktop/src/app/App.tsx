import type { ProviderId } from '@rill/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatPanel } from '../chat/ChatPanel'
import { ExplainPanel } from '../explain/ExplainPanel'
import { useT, type MessageKey } from '../i18n'
import { connectionsWithAccounts } from '../recipes/model/values'
import { RecipePanel } from '../recipes/RecipePanel'
import { Workspace, type InspectorExtraContext } from '../workspace/Workspace'
import styles from './App.module.css'
import { useEngineConnection } from './connection'
import controls from './controls.module.css'
import { FirstRunCard, firstRunDone, type FirstRunTarget } from './FirstRunCard'
import { ActionConfirm } from './ActionConfirm'
import { AgentsTab, type AgentsSectionId } from './agents/AgentsTab'
import { COMPOSER, fillChatDraft, handleExplainAction, nodeExists, type ConfirmText, type ExplainActionDeps } from './glue/actions'
import { createAttachmentPort } from './glue/attachments'
import { useHostConfigured } from './glue/host-models'
import { useConfirm } from './glue/useConfirm'
import { useEditContext } from './glue/editContext'
import { useEngineData } from './glue/useEngineData'
import { useReconnectNotice } from './glue/useReconnectNotice'
import { usePing } from './glue/usePing'
import { useSelection } from './glue/useSelection'
import { useConnect, useHost } from './host'
import { Layout } from './Layout'
import { NoticeBar, type NoticeAction, type NoticeData } from './NoticeBar'
import { Page } from './Page'
import { SettingsScreen } from './settings/SettingsScreen'
import type { SettingsSectionId } from './settings/types'
import { useSettings } from './settings/useSettings'
import { TopBar, type AppTab } from './TopBar'
import { useWorkflowList } from './workflows/useWorkflowList'
import { WorkflowActions } from './workflows/WorkflowActions'
import { WorkflowHeader } from './workflows/WorkflowHeader'

export interface AppProps {
  initial?: {
    tab?: AppTab
    workflowId?: string
    runId?: string
    nodeId?: string
    settingsSection?: SettingsSectionId
    agentsSection?: AgentsSectionId
    chatOpen?: boolean
  }
}

const CONFIRM_COPY: Record<ConfirmText, { title: MessageKey; confirm: MessageKey }> = {
  'app.confirm.retry': { title: 'app.retry.title', confirm: 'app.retry.confirm' },
  'app.confirm.deactivate': { title: 'app.deactivate.title', confirm: 'app.deactivate.confirm' },
}

export function App({ initial = {} }: AppProps) {
  const t = useT()
  const host = useHost()
  const connect = useConnect()
  const connection = useEngineConnection(host, { connect })
  const settings = useSettings(host)
  const connected = connection.state === 'connected'
  const live = useHostConfigured(connection.client, settings.settings?.configuredProviders)
  const earlier = useHostConfigured(connection.previous, settings.settings?.configuredProviders)
  const client = live ?? earlier
  const list = useWorkflowList(client)
  const data = useEngineData(client)
  const ping = usePing(connection.client)
  const selection = useSelection(initial)
  const [tab, setTab] = useState<AppTab>(initial.tab ?? 'workflows')
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(initial.settingsSection ?? 'folders')
  const [agentsSection, setAgentsSection] = useState<AgentsSectionId>(initial.agentsSection ?? 'agents')
  const [chatOpen, setChatOpen] = useState(initial.chatOpen ?? false)
  const [chatFocus, setChatFocus] = useState(0)
  const [notice, setNotice] = useState<NoticeData | undefined>(undefined)
  const [focusAction, setFocusAction] = useState<'dryRun' | 'activate' | undefined>(undefined)
  const [restarting, setRestarting] = useState(false)
  const [deletedTick, setDeletedTick] = useState(0)
  const chatRoot = useRef<HTMLElement>(null)
  const chatToggle = useRef<HTMLButtonElement>(null)
  const noticeId = useRef(0)
  const { pending, confirm } = useConfirm<ConfirmText>()
  const lastFocus = useRef<HTMLElement | null>(null)
  const heldFocus = useRef<HTMLElement | null>(null)
  const { forgetWorkflow } = selection
  const workflowId = selection.workflowId ?? list.workflows[0]?.id
  const { editContext, setEditContext, clearEditContext } = useEditContext(workflowId, initial.workflowId !== undefined && initial.nodeId !== undefined ? { workflowId: initial.workflowId, nodeId: initial.nodeId } : undefined)
  const port = useMemo(() => createAttachmentPort(host), [host])
  const summary = list.workflows.find((item) => item.id === workflowId)
  const savedConnections = settings.settings?.connections
  const accounts = settings.settings?.oauth.accounts
  const recipeConnections = useMemo(() => connectionsWithAccounts(savedConnections ?? [], accounts ?? []), [savedConnections, accounts])

  useEffect(() => {
    if (client === undefined) return undefined
    return client.onEvent((event) => {
      if (event.type === 'workflow.deleted') forgetWorkflow(event.workflowId)
    })
  }, [client, forgetWorkflow])

  useEffect(() => {
    if (deletedTick === 0) return
    const target = document.querySelector<HTMLElement>('[data-rill-region="workflow-switcher"] select') ?? document.querySelector<HTMLElement>('[data-rill-region="workspace"]')
    target?.focus()
  }, [deletedTick])

  useEffect(() => {
    if (chatFocus > 0) chatRoot.current?.querySelector<HTMLElement>(COMPOSER)?.focus()
  }, [chatFocus])

  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && event.target !== document.body) lastFocus.current = event.target
    }
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [])

  useEffect(() => {
    if (!connected) {
      const focused = lastFocus.current
      heldFocus.current = focused !== null && focused.isConnected && focused.matches(':disabled') ? focused : null
      return
    }
    const held = heldFocus.current
    heldFocus.current = null
    if (held !== null && (document.activeElement === null || document.activeElement === document.body)) held.focus()
  }, [connected])

  const notify = useCallback((key: MessageKey, vars?: Record<string, string | number>, action?: NoticeAction) => {
    noticeId.current += 1
    setNotice({ id: noticeId.current, key, ...(vars === undefined ? {} : { vars }), ...(action === undefined ? {} : { action }) })
  }, [])

  const goTab = (next: AppTab): void => {
    setFocusAction(undefined)
    setTab(next)
  }

  const openSettings = useCallback((section: FirstRunTarget) => {
    setSettingsSection(section)
    setTab('settings')
  }, [])

  useReconnectNotice(accounts, (providers) => {
    const action: NoticeAction = { key: 'app.notice.reconnect.action', run: () => openSettings('connections') }
    if (providers.length > 1) notify('app.notice.reconnectBoth', undefined, action)
    else notify('app.notice.reconnect', { provider: t(`app.connections.provider.${providers[0]!}`) }, action)
  })

  const workflowDeleted = (id: string): void => {
    list.forget(id)
    forgetWorkflow(id)
    void list.refresh()
    notify('app.notice.deleted')
    setDeletedTick((value) => value + 1)
  }

  const showWorkflow = (id: string, action?: 'dryRun' | 'activate'): void => {
    void list.refresh()
    selection.selectWorkflow(id)
    setFocusAction(action)
    setTab('workflows')
  }

  const selectNodeInGraph = (nodeId: string | undefined): void => {
    selection.selectNode(nodeId)
    if (nodeId !== undefined && workflowId !== undefined) setEditContext({ workflowId, nodeId })
    else clearEditContext()
  }

  const selectModel = (choice: { provider: ProviderId; model: string }): void => {
    host.settings.update({ provider: choice.provider, model: choice.model }).then(settings.apply, () => notify('app.notice.modelFailed'))
  }

  const restartEngine = (): void => {
    setRestarting(true)
    host.engine.restart().then(
      () => setRestarting(false),
      () => {
        setRestarting(false)
        notify('app.notice.actionFailed')
      },
    )
  }

  const pickPath = (kind: 'folder' | 'file'): Promise<string | undefined> => (kind === 'folder' ? host.dialogs.pickFolder() : host.dialogs.pickFile('any')).catch(() => undefined)

  const proposeFix = (proposal: { nodeId: string; requestText: string }): void => {
    setChatOpen(true)
    if (!fillChatDraft(chatRoot.current, proposal.requestText)) {
      notify('app.notice.chatUnavailable')
      return
    }
    setChatFocus((value) => value + 1)
    if (client === undefined || workflowId === undefined) return
    const target = workflowId
    nodeExists(client, target, proposal.nodeId).then(
      (found) => {
        if (!found) return
        selection.selectNode(proposal.nodeId)
        setEditContext({ workflowId: target, nodeId: proposal.nodeId })
      },
      () => undefined,
    )
  }

  const renderInspectorExtra = (context: InspectorExtraContext) => {
    const run = context.run
    if (run === undefined || run.status !== 'failed' || client === undefined) return null
    const deps: ExplainActionDeps = {
      client,
      openSettings,
      selectNode: selection.selectNode,
      setEditContext,
      confirm,
      notify,
      selectRun: selection.selectRun,
    }
    return (
      <ExplainPanel
        client={client}
        run={run}
        model={data.model}
        onAction={(action, where) => void handleExplainAction(action, { ...where, workflowId: run.workflowId, dryRun: run.dryRun }, deps)}
        onProposeFix={proposeFix}
      />
    )
  }

  const chat =
    client === undefined ? (
      <p className={controls.note} role="status">
        {t('app.chat.connecting')}
      </p>
    ) : (
      <>
        {connected ? null : (
          <p className={styles.pause} role="status">
            {t('app.chat.paused')}
          </p>
        )}
        <fieldset className={styles.reset} disabled={!connected}>
          <ChatPanel
            client={client}
            port={port}
            catalog={data.catalog}
            editContext={editContext}
            onClearEditContext={clearEditContext}
            onDeployed={(id) => showWorkflow(id, 'dryRun')}
            onSelectModel={selectModel}
          />
        </fieldset>
      </>
    )

  let main
  if (tab === 'settings') {
    main = <SettingsScreen state={settings} client={live} connection={connection} section={settingsSection} onSectionChange={setSettingsSection} />
  } else if (tab === 'recipes') {
    main =
      client === undefined ? (
        <p className={styles.placeholder} role="status">
          {t('app.main.connecting')}
        </p>
      ) : (
        <fieldset className={styles.reset} disabled={!connected}>
          <RecipePanel
            client={client}
            catalog={data.catalog}
            connections={recipeConnections}
            onPickPath={pickPath}
            onDeployed={(id) => showWorkflow(id)}
            onAction={(action, id) => showWorkflow(id, action === 'dry_run' ? 'dryRun' : 'activate')}
          />
        </fieldset>
      )
  } else if (tab === 'agents') {
    main =
      client === undefined ? (
        <p className={styles.placeholder} role="status">
          {t('app.main.connecting')}
        </p>
      ) : (
        <fieldset className={styles.reset} disabled={!connected}>
          <AgentsTab client={client} catalog={data.catalog} catalogStatus={data.catalogStatus} onRetryCatalog={data.reloadCatalog} files={host.dialogs} connections={settings.settings?.connections} onOpenConnections={() => openSettings('connections')} section={agentsSection} onSectionChange={setAgentsSection} />
        </fieldset>
      )
  } else {
    main = (
      <div className={styles.workflows}>
        <div className={styles.switcherRow} data-rill-region="workflow-switcher">
          <WorkflowHeader list={list} selectedId={workflowId} summary={summary} onSelect={selection.selectWorkflow} />
        </div>
        {settings.settings === undefined || firstRunDone(settings.settings) ? null : <FirstRunCard settings={settings.settings} onOpen={openSettings} />}
        {client === undefined ? (
          <p className={styles.placeholder} role="status">
            {t('app.main.connecting')}
          </p>
        ) : (
          <fieldset className={styles.reset} disabled={!connected}>
            {summary === undefined ? null : (
              <WorkflowActions key={summary.id} client={client} workflowId={summary.id} summary={summary} catalog={data.catalog} onRunStarted={selection.selectRun} onDeleted={workflowDeleted} focusAction={focusAction} />
            )}
            <div className={styles.workspace}>
              <Workspace
                client={client}
                workflowId={workflowId}
                selectedNodeId={selection.nodeId}
                onSelectNode={selectNodeInGraph}
                selectedRunId={selection.runId}
                onSelectRun={selection.selectRun}
                renderInspectorExtra={renderInspectorExtra}
              />
            </div>
          </fieldset>
        )}
      </div>
    )
  }

  return (
    <>
      <Layout
        chatOpen={chatOpen}
        onCloseChat={() => {
          setChatOpen(false)
          chatToggle.current?.focus()
        }}
        chatRef={chatRoot}
        topBar={
          <TopBar
            tab={tab}
            onTab={goTab}
            connection={connection}
            ping={ping}
            onRestart={restartEngine}
            restarting={restarting}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((open) => !open)}
            chatToggleRef={chatToggle}
          />
        }
        chat={chat}
        main={<Page>{main}</Page>}
        notice={<NoticeBar notice={notice} onDismiss={() => setNotice(undefined)} />}
      />
      {pending === undefined || client === undefined ? null : (
        <ActionConfirm
          client={client}
          catalog={data.catalog}
          title={CONFIRM_COPY[pending.text].title}
          message={pending.text}
          confirmLabel={CONFIRM_COPY[pending.text].confirm}
          {...(pending.workflowId === undefined ? {} : { effectsOf: pending.workflowId })}
          onAnswer={pending.settle}
        />
      )}
    </>
  )
}
