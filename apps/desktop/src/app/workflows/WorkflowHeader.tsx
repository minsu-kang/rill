import type { WorkflowSummary } from '@rill/protocol'
import { useT } from '../../i18n'
import { escapeInvisible } from '../../model/text'
import controls from '../controls.module.css'
import styles from './Workflows.module.css'
import type { WorkflowListState } from './useWorkflowList'
import { triggerText, WorkflowSwitcher } from './WorkflowSwitcher'

export interface WorkflowHeaderProps {
  list: Pick<WorkflowListState, 'status' | 'workflows' | 'refresh'>
  selectedId: string | undefined
  summary: WorkflowSummary | undefined
  onSelect(workflowId: string): void
}

export function WorkflowHeader({ list, selectedId, summary, onSelect }: WorkflowHeaderProps) {
  const t = useT()
  const many = list.workflows.length > 1
  const name = summary !== undefined ? escapeInvisible(summary.name) : t(selectedId === undefined ? 'app.wf.switcher.label' : 'app.wf.switcher.pending')
  return (
    <div className={styles.header}>
      <WorkflowSwitcher
        list={list}
        selectedId={selectedId}
        onSelect={onSelect}
        labelHidden
        className={many ? `${styles.titleBox} ${styles.pick}` : styles.titleBox}
        selectClassName={styles.overlay}
        selectTitle={many ? t('app.wf.switcher.tooltip') : undefined}
      >
        <h2 className={styles.name} title={name}>
          {name}
        </h2>
        {many ? (
          <svg className={styles.chevron} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M4 6l4 4 4-4" />
          </svg>
        ) : null}
      </WorkflowSwitcher>
      {summary === undefined || list.status !== 'ready' ? null : (
        <div className={styles.chips}>
          <span className={summary.active ? controls.chipOk : controls.chip}>{t(summary.active ? 'app.wf.active' : 'app.wf.inactive')}</span>
          <span className={controls.chip}>{triggerText(t, summary.triggerType)}</span>
        </div>
      )}
    </div>
  )
}
