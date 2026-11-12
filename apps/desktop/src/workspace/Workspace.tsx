import { useMemo, useState } from 'react'
import type { EngineClient } from '../engine/client'
import { useRunList, useRunStates } from '../engine/hooks'
import { useWorkflowSource } from '../engine/use-workflow'
import { WorkflowGraph } from '../graph/WorkflowGraph'
import { useT } from '../i18n'
import { Inspector } from '../inspector/Inspector'
import { displayState } from '../model/status'
import { escapeInvisible } from '../model/text'
import { RunHistory } from '../runs/RunHistory'
import styles from './Workspace.module.css'

export interface WorkspaceProps {
  client: EngineClient
  workflowId: string | undefined
  initialRunId?: string
  initialNodeId?: string
  now?: number
  timeZone?: string
}

export function Workspace(props: WorkspaceProps) {
  return <WorkspaceBody key={props.workflowId ?? ''} {...props} />
}

function WorkspaceBody({ client, workflowId, initialRunId, initialNodeId, now, timeZone }: WorkspaceProps) {
  const t = useT()
  const source = useWorkflowSource(client, workflowId)
  const list = useRunList(client, workflowId)
  const [runId, setRunId] = useState<string | undefined>(initialRunId)
  const [nodeId, setNodeId] = useState<string | undefined>(initialNodeId)
  const open = useRunStates(client, runId)
  const [clock] = useState(() => Date.now())

  const catalog = source.catalog
  const selected = source.workflow?.nodes.find((item) => item.id === nodeId)
  const info = useMemo(() => (selected === undefined ? undefined : catalog.find((entry) => entry.type === selected.type)), [catalog, selected])
  const errors = [...new Set([source.error, list.error, open.error].filter((message): message is string => message !== undefined))]

  return (
    <div className={styles.root} role="region" aria-label={t('workspace.label')}>
      <div className={styles.graph}>
        {errors.length > 0 && (
          <div className={styles.errors} role="alert">
            {errors.map((message) => (
              <p key={message} className={styles.error}>
                {t('workspace.loadError', { message: escapeInvisible(message) })}
              </p>
            ))}
          </div>
        )}
        {workflowId === undefined ? (
          <p className={styles.message}>{t('graph.empty')}</p>
        ) : source.workflow === undefined ? (
          source.loading && <p className={styles.message}>{t('workspace.loading')}</p>
        ) : (
          <WorkflowGraph workflow={source.workflow} catalog={catalog} states={open.states} selectedNodeId={nodeId} onSelect={setNodeId} />
        )}
      </div>
      <div className={styles.inspector}>
        <Inspector
          node={selected}
          info={info}
          steps={open.steps}
          state={selected === undefined ? undefined : displayState(selected, open.states)}
          timeZone={timeZone}
        />
      </div>
      <div className={styles.history}>
        <RunHistory runs={list.runs} selectedRunId={runId} now={now ?? clock} onSelect={setRunId} timeZone={timeZone} />
      </div>
    </div>
  )
}
