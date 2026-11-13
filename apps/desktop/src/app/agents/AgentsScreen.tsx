import { AGENT_DEFAULT_ID, type AgentField } from '@rill/protocol'
import { useRef, useState } from 'react'
import { TransferIcon } from '../../ui/TransferMark'
import { plainText } from '../../chat/model/clamp'
import { planErrorKey } from '../../chat/model/errors'
import { useAgents } from '../../engine/agents'
import type { EngineClient } from '../../engine/client'
import { useT, type MessageKey } from '../../i18n'
import { HostError, type HostApi } from '../../shared/host-api'
import { useStepFocus } from '../../ui/useStepFocus'
import visuallyHidden from '../../ui/visuallyHidden.module.css'
import controls from '../controls.module.css'
import { hostErrorKey } from '../settings/errors'
import { useAction } from '../settings/useAction'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import { AgentEditor } from './AgentEditor'
import { AgentImportReview } from './AgentImportReview'
import { parseAgentFile, serialiseAgentFile } from './agent-file'
import { AgentList } from './AgentList'
import styles from './AgentsScreen.module.css'
import { draftOf } from './model/draft'
import { exportFileName, reviewOutcome } from './model/review'
import { selectionOf, useAgentsView, type ViewAction } from './model/view'

export interface AgentsScreenProps {
  client: EngineClient
  files?: Pick<HostApi['dialogs'], 'openText' | 'saveText'>
}

type Asking = { kind: 'unsaved'; then: ViewAction; review: boolean; importAfter?: true } | { kind: 'delete' }

function actionError(error: unknown): MessageKey {
  return error instanceof HostError ? hostErrorKey(error) : planErrorKey(error)
}

export function AgentsScreen({ client, files }: AgentsScreenProps) {
  const t = useT()
  const { state: agents, store } = useAgents(client)
  const { state: view, store: viewStore } = useAgentsView(client)
  const action = useAction(actionError)
  const [status, setStatus] = useState<MessageKey | undefined>(undefined)
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  const [exportProblem, setExportProblem] = useState(false)
  const root = useRef<HTMLElement>(null)
  const selection = selectionOf(view, agents.agents, agents.activeId)
  const ready = agents.status === 'ready' || agents.agents.length > 0
  const review = view.review
  const outcome = review === undefined ? undefined : reviewOutcome(review, agents.agents)
  const selectedKey = review !== undefined ? '\u0000review' : selection.creating ? '\u0000new' : (selection.agent?.id ?? AGENT_DEFAULT_ID)
  const heading = useStepFocus(selectedKey, { container: root, scope: ready ? 'ready' : 'loading' })
  const agent = selection.agent

  function go(next: ViewAction): void {
    setStatus(undefined)
    setExportProblem(false)
    action.clearError()
    viewStore.dispatch(next)
  }

  function guarded(next: ViewAction): void {
    const same = next.type === 'select' && review === undefined && !selection.creating && agent?.id === next.id
    if (same) return
    if (review !== undefined) setAsking({ kind: 'unsaved', then: next, review: true })
    else if (selection.dirty) setAsking({ kind: 'unsaved', then: next, review: false })
    else go(next)
  }

  function startImport(): void {
    if (selection.dirty) setAsking({ kind: 'unsaved', then: { type: 'revert' }, review: false, importAfter: true })
    else importFile()
  }

  function edit(field: AgentField, value: string): void {
    setStatus(undefined)
    viewStore.dispatch({ type: 'edit', field, value, base: selection.baseline })
  }

  function save(): void {
    const draft = selection.draft
    const id = selection.creating ? undefined : agent?.id
    const creating = selection.creating
    setStatus(undefined)
    void action.run(async () => {
      const saved = await store.save({ ...draft, ...(id === undefined ? {} : { id }) })
      viewStore.dispatch({ type: 'saved', id: saved.id })
      setStatus(creating ? 'agents.status.created' : 'agents.status.saved')
    })
  }

  function importFile(): void {
    if (files === undefined) return
    setStatus(undefined)
    void action.run(async () => {
      const file = await files.openText()
      if (file === undefined) return
      viewStore.dispatch({ type: 'review', fileName: file.name, parsed: parseAgentFile(file.text) })
    })
  }

  function saveImport(): void {
    if (outcome?.fields === undefined || !outcome.canSave) return
    const fields = outcome.fields
    setStatus(undefined)
    void action.run(async () => {
      const saved = await store.save(fields)
      viewStore.dispatch({ type: 'saved', id: saved.id })
      setStatus('agents.status.imported')
    })
  }

  function exportFile(): void {
    if (files === undefined || agent === undefined || agent.builtin) return
    const serialised = serialiseAgentFile(draftOf(agent))
    setStatus(undefined)
    if (!serialised.ok) {
      setExportProblem(true)
      return
    }
    setExportProblem(false)
    const text = serialised.text
    const suggestedName = exportFileName(agent.name)
    void action.run(async () => {
      const result = await files.saveText({ suggestedName, text })
      if (result.saved) setStatus('agents.status.exported')
    })
  }

  function use(): void {
    if (agent === undefined) return
    const id = agent.id
    setStatus(undefined)
    void action.run(async () => {
      await store.select(id)
      setStatus('agents.status.activated')
    })
  }

  function remove(): void {
    if (agent === undefined || agent.builtin) return
    const id = agent.id
    void action.run(async () => {
      await store.remove(id)
      viewStore.dispatch({ type: 'select', id: AGENT_DEFAULT_ID })
      setAsking(undefined)
      setStatus('agents.status.deleted')
    })
  }

  return (
    <section ref={root} className={styles.root} aria-labelledby="agents-screen-title">
      <header className={styles.head}>
        <h2 id="agents-screen-title" className={visuallyHidden.hidden}>
          {t('agents.screen.title')}
        </h2>
        <p className={controls.note}>{t('agents.screen.intro')}</p>
        <p className={`${controls.note} ${styles.transfer}`}>
          <TransferIcon />
          <span>{t('agents.screen.transfer')}</span>
        </p>
      </header>
      {agents.status === 'loading' && !ready ? (
        <p className={controls.note} role="status">
          {t('agents.screen.loading')}
        </p>
      ) : null}
      {agents.status === 'error' && !ready ? (
        <div className={styles.loadError}>
          <p className={controls.error} role="alert">
            {t('agents.screen.loadError')}
          </p>
          <div className={controls.row}>
            <button type="button" className={controls.button} onClick={() => void store.refresh()}>
              {t('agents.screen.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {ready ? (
        <div className={styles.body}>
          <AgentList
            agents={agents.agents}
            activeId={agents.activeId}
            selectedId={review === undefined ? agent?.id : undefined}
            creating={selection.creating && review === undefined}
            onSelect={(id) => guarded({ type: 'select', id })}
            onCreate={() => guarded({ type: 'create' })}
            {...(files === undefined ? {} : { onImport: startImport })}
          />
          {review !== undefined && outcome !== undefined ? (
            <AgentImportReview
              review={review}
              outcome={outcome}
              busy={action.busy}
              error={asking === undefined ? action.error : undefined}
              headingRef={heading}
              onEdit={(field, value) => viewStore.dispatch({ type: 'reviewEdit', field, value })}
              onSave={saveImport}
              onCancel={() => go({ type: 'reviewClose' })}
            />
          ) : (
            <AgentEditor
              agent={agent}
              creating={selection.creating}
              draft={selection.draft}
              dirty={selection.dirty}
              inUse={agent?.id === agents.activeId}
              busy={action.busy}
              error={asking?.kind === 'delete' ? undefined : exportProblem ? 'agents.export.headingInText' : action.error}
              status={status}
              headingRef={heading}
              onChange={edit}
              onSave={save}
              onRevert={() => go({ type: 'revert' })}
              onDelete={() => {
                action.clearError()
                setAsking({ kind: 'delete' })
              }}
              onUse={use}
              {...(files === undefined ? {} : { onExport: exportFile })}
            />
          )}
        </div>
      ) : null}
      {asking?.kind === 'unsaved' ? (
        <ConfirmDialog
          title={t('agents.unsaved.title')}
          message={t(asking.review ? 'agents.unsaved.messageImport' : 'agents.unsaved.message')}
          confirmLabel={t('agents.unsaved.confirm')}
          cancelLabel={t('agents.unsaved.cancel')}
          danger
          onConfirm={() => {
            const next = asking.then
            const importAfter = asking.importAfter === true
            setAsking(undefined)
            go(next)
            if (importAfter) importFile()
          }}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
      {asking?.kind === 'delete' && agent !== undefined ? (
        <ConfirmDialog
          title={t('agents.delete.title')}
          message={t('agents.delete.message', { name: plainText(agent.name, 60) })}
          details={agent.id === agents.activeId ? <p className={controls.note}>{t('agents.delete.active')}</p> : undefined}
          confirmLabel={t('agents.delete.confirm')}
          cancelLabel={t('agents.delete.cancel')}
          danger
          busy={action.busy}
          error={action.error === undefined ? undefined : t(action.error)}
          onConfirm={remove}
          onCancel={() => {
            action.clearError()
            setAsking(undefined)
          }}
        />
      ) : null}
    </section>
  )
}
