import { AGENT_FIELD_LIMITS, type AgentField, type AgentRule } from '@rill/protocol'
import { useId, type FormEvent, type RefCallback } from 'react'
import { ClampedText } from '../../chat/ClampedText'
import { hiddenLabel, plainText } from '../../chat/model/clamp'
import { useT, type MessageKey, type Translate } from '../../i18n'
import controls from '../controls.module.css'
import { ruleText } from './AgentEditor'
import styles from './AgentsScreen.module.css'
import type { FileProblem } from './agent-file'
import type { ReviewOutcome } from './model/review'
import type { ReviewState } from './model/view'

export interface AgentImportReviewProps {
  review: ReviewState
  outcome: ReviewOutcome
  busy: boolean
  error: MessageKey | undefined
  headingRef?: RefCallback<HTMLElement>
  onEdit(field: 'name' | 'description', value: string): void
  onSave(): void
  onCancel(): void
}

function problemText(t: Translate, problem: FileProblem): string {
  if (problem.kind === 'field') return `${t(`agents.field.${problem.field}`)}: ${ruleText(t, problem.field, problem.rule)}`
  const message = t(`agents.file.problem.${problem.code}`)
  return problem.line === undefined ? message : t('agents.file.withLine', { line: problem.line, message })
}

function EditableField({ field, value, rule, disabled, onChange }: { field: 'name' | 'description'; value: string; rule: AgentRule | undefined; disabled: boolean; onChange(value: string): void }) {
  const t = useT()
  const id = useId()
  const error = `${id}-error`
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t(`agents.field.${field}`)}
      </label>
      <input
        id={id}
        type="text"
        className={styles.input}
        value={value}
        disabled={disabled}
        maxLength={AGENT_FIELD_LIMITS[field] * 4}
        aria-invalid={rule === undefined ? undefined : 'true'}
        aria-describedby={rule === undefined ? undefined : error}
        onChange={(event) => onChange(event.target.value)}
      />
      {rule === undefined ? null : (
        <p id={error} className={controls.error}>
          {ruleText(t, field, rule)}
        </p>
      )}
    </div>
  )
}

function ReadOnlyText({ label, text }: { label: string; text: string }) {
  const t = useT()
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.readOnly}>{text === '' ? t('agents.import.empty') : <ClampedText text={text.replaceAll('\t', hiddenLabel('\t'))} max={600} />}</div>
    </div>
  )
}

export function AgentImportReview({ review, outcome, busy, error, headingRef, onEdit, onSave, onCancel }: AgentImportReviewProps) {
  const t = useT()
  const problems: FileProblem[] = [
    ...outcome.fileProblems,
    ...(['persona', 'instructions'] as AgentField[]).flatMap((field): FileProblem[] => {
      const rule = outcome.fieldProblems[field]
      return rule === undefined ? [] : [{ kind: 'field', field, rule }]
    }),
  ]

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (outcome.canSave && !busy) onSave()
  }

  return (
    <section className={styles.editor} aria-labelledby="agents-editor-title">
      <h3 id="agents-editor-title" ref={headingRef} tabIndex={-1} className={styles.editorTitle}>
        {t('agents.import.title')}
      </h3>
      <p className={controls.note}>{t('agents.import.file', { name: plainText(review.fileName, 80) })}</p>
      <p className={controls.ok}>{t('agents.import.nothing')}</p>
      <p className={controls.note}>{t('agents.import.sent')}</p>
      {outcome.fields === undefined ? null : <p className={controls.note}>{t('agents.import.kindLine', { kind: t(`agents.kind.${outcome.kind ?? 'assistant'}`) })}</p>}
      {outcome.fields === undefined ? null : <p className={controls.note}>{t('agents.import.noSkills')}</p>}
      {problems.length > 0 || outcome.duplicate ? (
        <div className={controls.error} role="alert">
          <strong>{t('agents.import.problems')}</strong>
          <ul className={styles.problems}>
            {problems.map((problem, index) => (
              <li key={index}>{problemText(t, problem)}</li>
            ))}
            {outcome.duplicate ? <li>{t('agents.import.duplicate')}</li> : null}
          </ul>
        </div>
      ) : null}
      {outcome.fields === undefined ? (
        <p className={controls.note}>{t('agents.import.noFields')}</p>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate>
          <EditableField field="name" value={review.name} rule={outcome.fieldProblems.name} disabled={busy} onChange={(value) => onEdit('name', value)} />
          <EditableField field="description" value={review.description} rule={outcome.fieldProblems.description} disabled={busy} onChange={(value) => onEdit('description', value)} />
          <p className={controls.note}>{t('agents.import.readOnly')}</p>
          <ReadOnlyText label={t('agents.import.persona')} text={outcome.fields.persona} />
          <ReadOnlyText label={t('agents.import.instructions')} text={outcome.fields.instructions} />
          {error === undefined ? null : (
            <p className={controls.error} role="alert">
              {t(error)}
            </p>
          )}
          <div className={controls.row}>
            <button type="submit" className={controls.primary} disabled={!outcome.canSave || busy}>
              {t('agents.import.save')}
            </button>
            <button type="button" className={controls.button} disabled={busy} onClick={onCancel}>
              {t('agents.import.cancel')}
            </button>
          </div>
        </form>
      )}
      {outcome.fields === undefined ? (
        <div className={controls.row}>
          <button type="button" className={controls.button} onClick={onCancel}>
            {t('agents.import.cancel')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
