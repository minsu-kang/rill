import type { WorkflowSummary } from '@rill/protocol'
import { useId, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { escapeInvisible, truncate } from '../../model/text'
import controls from '../controls.module.css'
import { triggerKind } from './samples'
import styles from './Workflows.module.css'
import type { WorkflowListState } from './useWorkflowList'

export interface WorkflowSwitcherProps {
  list: Pick<WorkflowListState, 'status' | 'workflows' | 'refresh'>
  selectedId: string | undefined
  onSelect(workflowId: string): void
  labelHidden?: boolean
  className?: string
  selectClassName?: string
  selectTitle?: string
  children?: ReactNode
}

const MAX_NAME = 48

export function WorkflowSwitcher({ list, selectedId, onSelect, labelHidden = false, className, selectClassName, selectTitle, children }: WorkflowSwitcherProps) {
  const t = useT()
  const id = useId()
  const { status, workflows } = list

  if (status === 'error') {
    return (
      <div className={controls.row}>
        <span className={controls.note} role="alert">
          {t('app.wf.switcher.error')}
        </span>
        <button type="button" className={controls.button} onClick={() => void list.refresh()}>
          {t('app.wf.switcher.retry')}
        </button>
      </div>
    )
  }
  if (status === 'loading') return <span className={controls.note}>{t('app.wf.switcher.loading')}</span>
  if (workflows.length === 0) return <span className={controls.note}>{t('app.wf.switcher.empty')}</span>

  const known = selectedId === undefined || workflows.some((workflow) => workflow.id === selectedId)
  return (
    <div className={className === undefined ? styles.switcher : `${styles.switcher} ${className}`}>
      {children}
      <label className={labelHidden ? styles.labelHidden : styles.switcherLabel} htmlFor={id}>
        {t('app.wf.switcher.label')}
      </label>
      <select id={id} className={selectClassName ?? controls.input} title={selectTitle} value={selectedId ?? ''} onChange={(event) => onSelect(event.target.value)}>
        {selectedId === undefined ? <option value="" disabled /> : null}
        {known ? null : <option value={selectedId}>{t('app.wf.switcher.pending')}</option>}
        {workflows.map((workflow) => (
          <option key={workflow.id} value={workflow.id}>
            {optionText(t, workflow)}
          </option>
        ))}
      </select>
    </div>
  )
}

export function triggerText(t: ReturnType<typeof useT>, triggerType: string): string {
  const kind = triggerKind(triggerType)
  return kind === 'other' ? truncate(escapeInvisible(triggerType), 24) : t(`app.wf.trigger.${kind}`)
}

function optionText(t: ReturnType<typeof useT>, workflow: WorkflowSummary): string {
  return t('app.wf.option', { name: truncate(escapeInvisible(workflow.name), MAX_NAME), trigger: triggerText(t, workflow.triggerType), state: t(workflow.active ? 'app.wf.active' : 'app.wf.inactive') })
}
