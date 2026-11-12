import type { RunSummary, StepDetail } from '@rill/protocol'
import { useMemo, useState, type ReactNode } from 'react'
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
  selectedNodeId?: string | undefined
  onSelectNode?(nodeId: string | undefined): void
  selectedRunId?: string | undefined
  onSelectRun?(runId: string): void
  renderInspectorExtra?(context: InspectorExtraContext): ReactNode
  renderRunActions?(run: RunSummary): ReactNode
}

export interface InspectorExtraContext {
  workflowId: string | undefined
  nodeId: string | undefined
  run: RunSummary | undefined
  steps: readonly StepDetail[]
}

export function Workspace(props: WorkspaceProps) {
  return <WorkspaceBody key={props.workflowId ?? ''} {...props} />
}

function WorkspaceBody(props: WorkspaceProps) {
  const { client, workflowId, initialRunId, initialNodeId, now, timeZone, onSelectNode, onSelectRun, renderInspectorExtra, renderRunActions } = props
  const t = useT()
  const source = useWorkflowSource(client, workflowId)
  const list = useRunList(client, workflowId)
  const [ownRunId, setOwnRunId] = useState<string | undefined>(initialRunId)
  const [ownNodeId, setOwnNodeId] = useState<string | undefined>(initialNodeId)
  const runId = Object.hasOwn(props, 'selectedRunId') ? props.selectedRunId : ownRunId
  const nodeId = Object.hasOwn(props, 'selectedNodeId') ? props.selectedNodeId : ownNodeId
  const setRunId = (next: string): void => {
    setOwnRunId(next)
    onSelectRun?.(next)
  }
  const setNodeId = (next: string | undefined): void => {
    setOwnNodeId(next)
    onSelectNode?.(next)
  }
  const open = useRunStates(client, runId)
  const [clock] = useState(() => Date.now())

  const catalog = source.catalog
  const selected = source.workflow?.nodes.find((item) => item.id === nodeId)
  const info = useMemo(() => (selected === undefined ? undefined : catalog.find((entry) => entry.type === selected.type)), [catalog, selected])
  const errors = [...new Set([source.error, list.error, open.error].filter((message): message is string => message !== undefined))]
  const runSummary = runId === undefined ? undefined : (open.run ?? list.runs.find((item) => item.id === runId))
  const extra = renderInspectorExtra?.({ workflowId, nodeId, run: runSummary, steps: open.steps })
  const runActions = runSummary === undefined ? undefined : renderRunActions?.(runSummary)
  const inspector = (
    <Inspector
      node={selected}
      info={info}
      steps={open.steps}
      state={selected === undefined ? undefined : displayState(selected, open.states)}
      timeZone={timeZone}
    />
  )
  const history = <RunHistory runs={list.runs} selectedRunId={runId} now={now ?? clock} onSelect={setRunId} timeZone={timeZone} />

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
        {extra === undefined || extra === null || extra === false ? (
          inspector
        ) : (
          <div className={styles.stack}>
            <div className={styles.extra}>{extra}</div>
            <div className={styles.stackMain}>{inspector}</div>
          </div>
        )}
      </div>
      <div className={styles.history}>
        {runActions === undefined || runActions === null || runActions === false ? (
          history
        ) : (
          <div className={styles.stack}>
            <div className={styles.stackMain}>{history}</div>
            <div className={styles.runActions}>{runActions}</div>
          </div>
        )}
      </div>
    </div>
  )
}
