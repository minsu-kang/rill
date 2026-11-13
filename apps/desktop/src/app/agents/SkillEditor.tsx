import { SKILL_DESCRIPTION_MAX_INPUT_CHARS, SKILL_FIELD_LIMITS, SKILL_FIELDS, SKILL_NAME_MAX_INPUT_CHARS, SKILL_BODY_MAX_INPUT_CHARS, AGENT_SKILLS_MAX_CHARS, type Agent, type AgentRule, type Skill, type SkillField } from '@rill/protocol'
import { useId, type FormEvent, type RefCallback } from 'react'
import { useT, type MessageKey, type Translate } from '../../i18n'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import styles from './AgentsScreen.module.css'
import { hasSkillProblems, skillCountOf, skillDraftProblems, type SkillDraft } from './model/skill-draft'

export interface SkillEditorProps {
  skill: Skill | undefined
  creating: boolean
  draft: SkillDraft
  dirty: boolean
  busy: boolean
  error: MessageKey | undefined
  status: MessageKey | undefined
  users: readonly Agent[]
  headingRef?: RefCallback<HTMLElement>
  onChange(field: SkillField, value: string): void
  onSave(): void
  onRevert(): void
  onDelete(): void
  onExport?(): void
}

const INPUT_CAPS: Readonly<Record<SkillField, number>> = {
  name: SKILL_NAME_MAX_INPUT_CHARS,
  description: SKILL_DESCRIPTION_MAX_INPUT_CHARS,
  body: SKILL_BODY_MAX_INPUT_CHARS,
}

const ROWS: Readonly<Record<SkillField, number>> = { name: 1, description: 1, body: 10 }

export function skillRuleText(t: Translate, field: SkillField, rule: AgentRule): string {
  switch (rule) {
    case 'empty':
      return t(field === 'body' ? 'skills.rule.empty.body' : 'skills.rule.empty.name')
    case 'too_long':
      return t('agents.rule.too_long', { max: SKILL_FIELD_LIMITS[field] })
    case 'control_character':
      return t(field === 'body' ? 'agents.rule.control_character.multiLine' : 'agents.rule.control_character.oneLine')
    case 'line_separator':
      return t('agents.rule.line_separator')
    case 'bidi_format':
      return t('agents.rule.bidi_format')
    case 'format_character':
      return t('agents.rule.format_character')
  }
}

function FieldBox({ field, value, rule, disabled, onChange }: { field: SkillField; value: string; rule: AgentRule | undefined; disabled: boolean; onChange(value: string): void }) {
  const t = useT()
  const id = useId()
  const hint = `${id}-hint`
  const count = `${id}-count`
  const error = `${id}-error`
  const length = skillCountOf(field, value)
  const common = {
    id,
    className: styles.input,
    value,
    disabled,
    maxLength: INPUT_CAPS[field],
    'aria-invalid': rule === undefined ? undefined : ('true' as const),
    'aria-describedby': [hint, count, rule === undefined ? undefined : error].filter((part) => part !== undefined).join(' '),
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  }
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t(`skills.field.${field}`)}
      </label>
      {field === 'body' ? <textarea {...common} rows={ROWS[field]} /> : <input {...common} type="text" />}
      <div className={styles.fieldMeta}>
        <p id={hint} className={styles.hint}>
          {t(`skills.field.${field}.hint`)}
        </p>
        <p id={count} className={length > SKILL_FIELD_LIMITS[field] ? styles.countOver : styles.counter}>
          {t('skills.field.count', { count: length, max: SKILL_FIELD_LIMITS[field] })}
        </p>
      </div>
      {rule === undefined ? null : (
        <p id={error} className={controls.error}>
          {skillRuleText(t, field, rule)}
        </p>
      )}
    </div>
  )
}

export function SkillEditor({ skill, creating, draft, dirty, busy, error, status, users, headingRef, onChange, onSave, onRevert, onDelete, onExport }: SkillEditorProps) {
  const t = useT()
  const problems = skillDraftProblems(draft)
  const canSave = !hasSkillProblems(problems) && (creating || dirty)

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (canSave && !busy) onSave()
  }

  return (
    <section className={styles.editor} aria-labelledby="skills-editor-title">
      <h3 id="skills-editor-title" ref={headingRef} tabIndex={-1} className={styles.editorTitle}>
        {creating ? t('skills.editor.newTitle') : <SafeText text={skill?.name ?? ''} />}
      </h3>
      <form className={styles.form} onSubmit={submit} noValidate>
        {SKILL_FIELDS.map((field) => (
          <FieldBox key={field} field={field} value={draft[field]} rule={problems[field]} disabled={busy} onChange={(value) => onChange(field, value)} />
        ))}
        <p className={controls.note}>{t('skills.editor.budget', { max: AGENT_SKILLS_MAX_CHARS })}</p>
        {dirty ? <p className={controls.note}>{t('skills.editor.unsaved')}</p> : null}
        {error === undefined ? null : (
          <p className={controls.error} role="alert">
            {t(error)}
          </p>
        )}
        <div className={controls.row}>
          <button type="submit" className={controls.primary} disabled={!canSave || busy}>
            {t(creating ? 'skills.editor.create' : 'skills.editor.save')}
          </button>
          {dirty && !creating ? (
            <button type="button" className={controls.button} disabled={busy} onClick={onRevert}>
              {t('skills.editor.revert')}
            </button>
          ) : null}
          {creating ? null : (
            <>
              {onExport === undefined ? null : (
                <button type="button" className={controls.button} disabled={busy || dirty} aria-describedby={dirty ? 'skills-export-hint' : undefined} onClick={onExport}>
                  {t('skills.export.button')}
                </button>
              )}
              <button type="button" className={controls.danger} disabled={busy} onClick={onDelete}>
                {t('skills.editor.delete')}
              </button>
            </>
          )}
        </div>
        {dirty && !creating ? (
          <p id="skills-export-hint" className={controls.note}>
            {t('skills.editor.saveFirst')}
          </p>
        ) : null}
      </form>
      {creating ? null : users.length === 0 ? (
        <p className={controls.note}>{t('skills.editor.unused')}</p>
      ) : (
        <div className={styles.usedBy}>
          <h4 className={styles.subTitle}>{t('skills.editor.usedBy')}</h4>
          <ul className={styles.usedList} aria-label={t('skills.editor.usedBy')}>
            {users.map((agent) => (
              <li key={agent.id}>
                <SafeText text={agent.name} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className={controls.ok} role="status" hidden={status === undefined}>
        {status === undefined ? '' : t(status)}
      </p>
    </section>
  )
}
