import { SKILL_FIELD_LIMITS, type AgentRule } from '@rill/protocol'
import { useId, type FormEvent, type RefCallback } from 'react'
import { ClampedText } from '../../chat/ClampedText'
import { hiddenLabel, plainText } from '../../chat/model/clamp'
import { useT, type MessageKey, type Translate } from '../../i18n'
import controls from '../controls.module.css'
import { skillRuleText } from './SkillEditor'
import styles from './AgentsScreen.module.css'
import type { SkillReviewOutcome } from './model/skill-review'
import type { SkillReviewState } from './model/skill-view'
import type { SkillFileProblem } from './skill-file'

export interface SkillImportReviewProps {
  review: SkillReviewState
  outcome: SkillReviewOutcome
  busy: boolean
  error: MessageKey | undefined
  headingRef?: RefCallback<HTMLElement>
  onEdit(field: 'name' | 'description', value: string): void
  onSave(): void
  onCancel(): void
}

function problemText(t: Translate, problem: SkillFileProblem): string {
  if (problem.kind === 'field') return `${t(`skills.field.${problem.field}`)}: ${skillRuleText(t, problem.field, problem.rule)}`
  const message = t(`skills.file.problem.${problem.code}`)
  return problem.line === undefined ? message : t('skills.file.withLine', { line: problem.line, message })
}

function EditableField({ field, value, rule, disabled, onChange }: { field: 'name' | 'description'; value: string; rule: AgentRule | undefined; disabled: boolean; onChange(value: string): void }) {
  const t = useT()
  const id = useId()
  const error = `${id}-error`
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t(`skills.field.${field}`)}
      </label>
      <input
        id={id}
        type="text"
        className={styles.input}
        value={value}
        disabled={disabled}
        maxLength={SKILL_FIELD_LIMITS[field] * 4}
        aria-invalid={rule === undefined ? undefined : 'true'}
        aria-describedby={rule === undefined ? undefined : error}
        onChange={(event) => onChange(event.target.value)}
      />
      {rule === undefined ? null : (
        <p id={error} className={controls.error}>
          {skillRuleText(t, field, rule)}
        </p>
      )}
    </div>
  )
}

export function SkillImportReview({ review, outcome, busy, error, headingRef, onEdit, onSave, onCancel }: SkillImportReviewProps) {
  const t = useT()
  const bodyRule = outcome.fieldProblems.body
  const problems: SkillFileProblem[] = [...outcome.fileProblems, ...(bodyRule === undefined ? [] : [{ kind: 'field', field: 'body', rule: bodyRule } as const])]

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (outcome.canSave && !busy) onSave()
  }

  return (
    <section className={styles.editor} aria-labelledby="skills-editor-title">
      <h3 id="skills-editor-title" ref={headingRef} tabIndex={-1} className={styles.editorTitle}>
        {t('skills.import.title')}
      </h3>
      <p className={controls.note}>{t('skills.import.file', { name: plainText(review.fileName, 80) })}</p>
      <p className={controls.ok}>{t('skills.import.nothing')}</p>
      <p className={controls.note}>{t('skills.import.sent')}</p>
      {problems.length > 0 || outcome.duplicate ? (
        <div className={controls.error} role="alert">
          <strong>{t('skills.import.problems')}</strong>
          <ul className={styles.problems}>
            {problems.map((problem, index) => (
              <li key={index}>{problemText(t, problem)}</li>
            ))}
            {outcome.duplicate ? <li>{t('skills.import.duplicate')}</li> : null}
          </ul>
        </div>
      ) : null}
      {outcome.fields === undefined ? (
        <p className={controls.note}>{t('skills.import.noFields')}</p>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate>
          <EditableField field="name" value={review.name} rule={outcome.fieldProblems.name} disabled={busy} onChange={(value) => onEdit('name', value)} />
          <EditableField field="description" value={review.description} rule={outcome.fieldProblems.description} disabled={busy} onChange={(value) => onEdit('description', value)} />
          <p className={controls.note}>{t('skills.import.readOnly')}</p>
          <div className={styles.field}>
            <span className={styles.label}>{t('skills.import.body')}</span>
            <div className={styles.readOnly}>{outcome.fields.body === '' ? t('skills.import.empty') : <ClampedText text={outcome.fields.body.replaceAll('\t', hiddenLabel('\t'))} max={1200} />}</div>
          </div>
          {error === undefined ? null : (
            <p className={controls.error} role="alert">
              {t(error)}
            </p>
          )}
          <div className={controls.row}>
            <button type="submit" className={controls.primary} disabled={!outcome.canSave || busy}>
              {t('skills.import.save')}
            </button>
            <button type="button" className={controls.button} disabled={busy} onClick={onCancel}>
              {t('skills.import.cancel')}
            </button>
          </div>
        </form>
      )}
      {outcome.fields === undefined ? (
        <div className={controls.row}>
          <button type="button" className={controls.button} onClick={onCancel}>
            {t('skills.import.cancel')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
