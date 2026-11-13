import { AGENT_DEFAULT_ID, type AgentField } from '@rill/protocol'
import { useRef, useState } from 'react'
import { ExternalTransferNotice } from '../../chat/ExternalTransferNotice'
import { plainText } from '../../chat/model/clamp'
import { planErrorKey } from '../../chat/model/errors'
import { useAgents } from '../../engine/agents'
import type { EngineClient } from '../../engine/client'
import { useT, type MessageKey } from '../../i18n'
import { useStepFocus } from '../../ui/useStepFocus'
import controls from '../controls.module.css'
import { useAction } from '../settings/useAction'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import { AgentEditor } from './AgentEditor'
import { AgentList } from './AgentList'
import styles from './AgentsScreen.module.css'
import { selectionOf, useAgentsView, type ViewAction } from './model/view'

export interface AgentsScreenProps {
  client: EngineClient
}

type Asking = { kind: 'unsaved'; then: ViewAction } | { kind: 'delete' }

export function AgentsScreen({ client }: AgentsScreenProps) {
  const t = useT()
  const { state: agents, store } = useAgents(client)
  const { state: view, store: viewStore } = useAgentsView(client)
  const action = useAction(planErrorKey)
  const [status, setStatus] = useState<MessageKey | undefined>(undefined)
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  const root = useRef<HTMLElement>(null)
  const selection = selectionOf(view, agents.agents, agents.activeId)
  const ready = agents.status === 'ready' || agents.agents.length > 0
  const selectedKey = selection.creating ? '\u0000new' : (selection.agent?.id ?? AGENT_DEFAULT_ID)
  const heading = useStepFocus(selectedKey, { container: root, scope: ready ? 'ready' : 'loading' })
  const agent = selection.agent

  function go(next: ViewAction): void {
    setStatus(undefined)
    action.clearError()
    viewStore.dispatch(next)
  }

  function guarded(next: ViewAction): void {
    const same = next.type === 'select' && !selection.creating && agent?.id === next.id
    if (same) return
    if (selection.dirty) setAsking({ kind: 'unsaved', then: next })
    else go(next)
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
        <h2 id="agents-screen-title" className={styles.title}>
          {t('agents.screen.title')}
        </h2>
        <p className={controls.note}>{t('agents.screen.intro')}</p>
        <ExternalTransferNotice items={['agent']} />
        <p className={controls.note}>{t('agents.screen.transfer')}</p>
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
            selectedId={agent?.id}
            creating={selection.creating}
            onSelect={(id) => guarded({ type: 'select', id })}
            onCreate={() => guarded({ type: 'create' })}
          />
          <AgentEditor
            agent={agent}
            creating={selection.creating}
            draft={selection.draft}
            dirty={selection.dirty}
            inUse={agent?.id === agents.activeId}
            busy={action.busy}
            error={asking?.kind === 'delete' ? undefined : action.error}
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
          />
        </div>
      ) : null}
      {asking?.kind === 'unsaved' ? (
        <ConfirmDialog
          title={t('agents.unsaved.title')}
          message={t('agents.unsaved.message')}
          confirmLabel={t('agents.unsaved.confirm')}
          cancelLabel={t('agents.unsaved.cancel')}
          danger
          onConfirm={() => {
            const next = asking.then
            setAsking(undefined)
            go(next)
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
