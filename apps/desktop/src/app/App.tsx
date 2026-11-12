import type { ProviderId } from '@rill/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatPanel } from '../chat/ChatPanel'
import { ExplainPanel } from '../explain/ExplainPanel'
import { useT, type MessageKey } from '../i18n'
import { RecipePanel } from '../recipes/RecipePanel'
import { Workspace, type InspectorExtraContext } from '../workspace/Workspace'
import styles from './App.module.css'
import { useEngineConnection } from './connection'
import controls from './controls.module.css'
import { FirstRunCard, firstRunDone, type FirstRunTarget } from './FirstRunCard'
import { fillChatDraft, handleExplainAction, nodeExists, type ExplainActionDeps } from './glue/actions'
import { createAttachmentPort } from './glue/attachments'
import { useEditContext } from './glue/editContext'
import { useEngineData } from './glue/useEngineData'
import { usePing } from './glue/usePing'
import { useSelection } from './glue/useSelection'
import { useConnect, useHost } from './host'
import { Layout } from './Layout'
import { NoticeBar, type NoticeData } from './NoticeBar'
import { SettingsScreen } from './settings/SettingsScreen'
import type { SettingsSectionId } from './settings/types'
import { useSettings } from './settings/useSettings'
import { TopBar, type AppTab } from './TopBar'
import { useWorkflowList } from './workflows/useWorkflowList'
import { WorkflowActions } from './workflows/WorkflowActions'

export interface AppProps {
  initial?: {
    tab?: AppTab
    workflowId?: string
    runId?: string
    nodeId?: string
    settingsSection?: SettingsSectionId
    chatOpen?: boolean
  }
}

const ALWAYS_YES = (): Promise<boolean> => Promise.resolve(true)

export function App({ initial = {} }: AppProps) {
  const t = useT()
  const host = useHost()
  const connect = useConnect()
  const connection = useEngineConnection(host, { connect })
  const settings = useSettings(host)
  const connected = connection.state === 'connected'
  const client = connection.client ?? connection.previous
  const list = useWorkflowList(client)
  const data = useEngineData(client)
  const ping = usePing(connection.client)
  const selection = useSelection(initial)
  const [tab, setTab] = useState<AppTab>(initial.tab ?? 'workflows')
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(initial.settingsSection ?? 'folders')
  const [chatOpen, setChatOpen] = useState(initial.chatOpen ?? false)
  const [chatFocus, setChatFocus] = useState(0)
  const [notice, setNotice] = useState<NoticeData | undefined>(undefined)
  const [focusAction, setFocusAction] = useState<'dryRun' | 'activate' | undefined>(undefined)
  const [restarting, setRestarting] = useState(false)
  const chatRoot = useRef<HTMLElement>(null)
  const chatToggle = useRef<HTMLButtonElement>(null)
  const noticeId = useRef(0)
  const workflowId = selection.workflowId ?? list.workflows[0]?.id
  const { editContext, setEditContext, clearEditContext } = useEditContext(workflowId, initial.workflowId !== undefined && initial.nodeId !== undefined ? { workflowId: initial.workflowId, nodeId: initial.nodeId } : undefined)
  const port = useMemo(() => createAttachmentPort(host), [host])
  const summary = list.workflows.find((item) => item.id === workflowId)

  useEffect(() => {
    if (chatFocus > 0) chatRoot.current?.querySelector('textarea')?.focus()
  }, [chatFocus])

  const notify = useCallback((key: MessageKey, vars?: Record<string, string | number>) => {
    noticeId.current += 1
    setNotice({ id: noticeId.current, key, ...(vars === undefined ? {} : { vars }) })
  }, [])

  const goTab = (next: AppTab): void => {
    setFocusAction(undefined)
    setTab(next)
  }

  const openSettings = useCallback((section: FirstRunTarget) => {
    setSettingsSection(section)
    setTab('settings')
  }, [])

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
      confirm: ALWAYS_YES,
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
    main = <SettingsScreen state={settings} client={connection.client} connection={connection} section={settingsSection} onSectionChange={setSettingsSection} />
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
            connections={settings.settings?.connections ?? []}
            onPickPath={pickPath}
            onDeployed={(id) => showWorkflow(id)}
            onAction={(action, id) => showWorkflow(id, action === 'dry_run' ? 'dryRun' : 'activate')}
          />
        </fieldset>
      )
  } else {
    main = (
      <div className={styles.workflows}>
        {settings.settings === undefined || firstRunDone(settings.settings) ? null : <FirstRunCard settings={settings.settings} onOpen={openSettings} />}
        {client === undefined ? (
          <p className={styles.placeholder} role="status">
            {t('app.main.connecting')}
          </p>
        ) : (
          <fieldset className={styles.reset} disabled={!connected}>
            {summary === undefined ? null : (
              <WorkflowActions client={client} workflowId={summary.id} summary={summary} catalog={data.catalog} onRunStarted={selection.selectRun} focusAction={focusAction} />
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
          list={list}
          selectedId={workflowId}
          onSelectWorkflow={(id) => {
            selection.selectWorkflow(id)
            goTab('workflows')
          }}
          connection={connection}
          ping={ping}
          model={data.model}
          onRestart={restartEngine}
          restarting={restarting}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((open) => !open)}
          chatToggleRef={chatToggle}
        />
      }
      chat={chat}
      main={main}
      notice={<NoticeBar notice={notice} onDismiss={() => setNotice(undefined)} />}
    />
  )
}
