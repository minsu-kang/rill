import {
  AGENT_FIELD_LIMITS,
  AGENT_FIELDS,
  AGENT_KINDS,
  AGENT_NAME_MAX_INPUT_CHARS,
  AGENT_DESCRIPTION_MAX_INPUT_CHARS,
  AGENT_PERSONA_MAX_INPUT_CHARS,
  AGENT_INSTRUCTIONS_MAX_INPUT_CHARS,
  isMultiLineAgentField,
  type Agent,
  type AgentField,
  type AgentKind,
  type AgentRule,
} from '@rill/protocol'
import { Fragment, useId, type FormEvent, type RefCallback } from 'react'
import { kindOf } from '../../engine/agents'
import type { SkillsState } from '../../engine/skills'
import { useT, type MessageKey, type Translate } from '../../i18n'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import styles from './AgentsScreen.module.css'
import { countOf, draftProblems, hasProblems, skillsProblem, type AgentDraft } from './model/draft'
import { SkillsPicker } from './SkillsPicker'

export interface AgentEditorProps {
  agent: Agent | undefined
  creating: boolean
  draft: AgentDraft
  dirty: boolean
  inUse: boolean
  busy: boolean
  error: MessageKey | undefined
  status: MessageKey | undefined
  skills: SkillsState
  skillsGone?: boolean
  headingRef?: RefCallback<HTMLElement>
  onChange(field: AgentField, value: string): void
  onKind(kind: AgentKind): void
  onSkills(ids: string[]): void
  onRetrySkills(): void
  onSave(): void
  onRevert(): void
  onDelete(): void
  onUse(): void
  onExport?(): void
}

const INPUT_CAPS: Readonly<Record<AgentField, number>> = {
  name: AGENT_NAME_MAX_INPUT_CHARS,
  description: AGENT_DESCRIPTION_MAX_INPUT_CHARS,
  persona: AGENT_PERSONA_MAX_INPUT_CHARS,
  instructions: AGENT_INSTRUCTIONS_MAX_INPUT_CHARS,
}

const ROWS: Readonly<Record<AgentField, number>> = { name: 1, description: 1, persona: 4, instructions: 10 }

export function ruleText(t: Translate, field: AgentField, rule: AgentRule): string {
  switch (rule) {
    case 'empty':
      return t('agents.rule.empty')
    case 'too_long':
      return t('agents.rule.too_long', { max: AGENT_FIELD_LIMITS[field] })
    case 'control_character':
      return t(isMultiLineAgentField(field) ? 'agents.rule.control_character.multiLine' : 'agents.rule.control_character.oneLine')
    case 'line_separator':
      return t('agents.rule.line_separator')
    case 'bidi_format':
      return t('agents.rule.bidi_format')
    case 'format_character':
      return t('agents.rule.format_character')
  }
}

function FieldBox({ field, value, rule, disabled, onChange }: { field: AgentField; value: string; rule: AgentRule | undefined; disabled: boolean; onChange(value: string): void }) {
  const t = useT()
  const id = useId()
  const hint = `${id}-hint`
  const count = `${id}-count`
  const error = `${id}-error`
  const length = countOf(field, value)
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
        {t(`agents.field.${field}`)}
      </label>
      {isMultiLineAgentField(field) ? <textarea {...common} rows={ROWS[field]} /> : <input {...common} type="text" />}
      <div className={styles.fieldMeta}>
        <p id={hint} className={styles.hint}>
          {t(`agents.field.${field}.hint`)}
        </p>
        <p id={count} className={length > AGENT_FIELD_LIMITS[field] ? styles.countOver : styles.counter}>
          {t('agents.field.count', { count: length, max: AGENT_FIELD_LIMITS[field] })}
        </p>
      </div>
      {rule === undefined ? null : (
        <p id={error} className={controls.error}>
          {ruleText(t, field, rule)}
        </p>
      )}
    </div>
  )
}

function KindField({ kind, locked, disabled, onChange }: { kind: AgentKind; locked: boolean; disabled: boolean; onChange(kind: AgentKind): void }) {
  const t = useT()
  const id = useId()
  const hint = `${id}-hint`
  const lock = `${id}-lock`
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t('agents.field.kind')}
      </label>
      <select id={id} className={styles.select} value={kind} disabled={disabled || locked} aria-describedby={locked ? `${hint} ${lock}` : hint} onChange={(event) => onChange(event.target.value as AgentKind)}>
        {AGENT_KINDS.map((value) => (
          <option key={value} value={value}>
            {t(`agents.kind.${value}`)}
          </option>
        ))}
      </select>
      <p id={hint} className={styles.hint}>
        {t(`agents.kind.hint.${kind}`)}
      </p>
      {locked ? (
        <p id={lock} className={styles.hint}>
          {t('agents.kind.lockedInUse')}
        </p>
      ) : null}
    </div>
  )
}

export function AgentEditor({ agent, creating, draft, dirty, inUse, busy, error, status, skills, skillsGone = false, headingRef, onChange, onKind, onSkills, onRetrySkills, onSave, onRevert, onDelete, onUse, onExport }: AgentEditorProps) {
  const t = useT()
  const problems = draftProblems(draft)
  const skillsFailed = skills.status === 'ready' && skillsProblem(draft.skillIds, skills.skills) !== undefined
  const canSave = !hasProblems(problems) && !skillsFailed && (creating || dirty)
  const reviewer = !creating && agent !== undefined && kindOf(agent) === 'reviewer'

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (canSave && !busy) onSave()
  }

  if (agent?.builtin === true) {
    return (
      <section className={styles.editor} aria-labelledby="agents-editor-title">
        <h3 id="agents-editor-title" ref={headingRef} tabIndex={-1} className={styles.editorTitle}>
          {t('agents.default.name')}
        </h3>
        <p className={controls.note}>{t('agents.default.description')}</p>
        <p className={controls.note}>{t('agents.editor.defaultNote')}</p>
        {error === undefined ? null : (
          <p className={controls.error} role="alert">
            {t(error)}
          </p>
        )}
        <div className={controls.row}>
          <button type="button" className={controls.primary} disabled={inUse || busy} onClick={onUse}>
            {t(inUse ? 'agents.editor.inUse' : 'agents.editor.use')}
          </button>
        </div>
        <p className={controls.ok} role="status" hidden={status === undefined}>
          {status === undefined ? '' : t(status)}
        </p>
      </section>
    )
  }

  return (
    <section className={styles.editor} aria-labelledby="agents-editor-title">
      <h3 id="agents-editor-title" ref={headingRef} tabIndex={-1} className={styles.editorTitle}>
        {creating ? t('agents.editor.newTitle') : <SafeText text={agent?.name ?? ''} />}
      </h3>
      <form className={styles.form} onSubmit={submit} noValidate>
        {AGENT_FIELDS.map((field) => (
          <Fragment key={field}>
            <FieldBox field={field} value={draft[field]} rule={problems[field]} disabled={busy} onChange={(value) => onChange(field, value)} />
            {field === 'description' ? <KindField kind={draft.kind} locked={inUse && !creating} disabled={busy} onChange={onKind} /> : null}
          </Fragment>
        ))}
        <SkillsPicker skills={skills} value={draft.skillIds} gone={skillsGone} disabled={busy} onChange={onSkills} onRetry={onRetrySkills} />
        {dirty ? <p className={controls.note}>{t('agents.editor.unsaved')}</p> : null}
        {error === undefined ? null : (
          <p className={controls.error} role="alert">
            {t(error)}
          </p>
        )}
        <div className={controls.row}>
          <button type="submit" className={controls.primary} disabled={!canSave || busy}>
            {t(creating ? 'agents.editor.create' : 'agents.editor.save')}
          </button>
          {dirty && !creating ? (
            <button type="button" className={controls.button} disabled={busy} onClick={onRevert}>
              {t('agents.editor.revert')}
            </button>
          ) : null}
          {creating ? null : (
            <>
              {reviewer ? null : (
                <button type="button" className={controls.button} disabled={busy || inUse || dirty} aria-describedby={dirty ? 'agents-use-hint' : undefined} onClick={onUse}>
                  {t(inUse ? 'agents.editor.inUse' : 'agents.editor.use')}
                </button>
              )}
              {onExport === undefined ? null : (
                <button type="button" className={controls.button} disabled={busy || dirty} aria-describedby={dirty ? 'agents-use-hint' : undefined} onClick={onExport}>
                  {t('agents.export.button')}
                </button>
              )}
              <button type="button" className={controls.danger} disabled={busy} onClick={onDelete}>
                {t('agents.editor.delete')}
              </button>
            </>
          )}
        </div>
        {dirty && !creating ? (
          <p id="agents-use-hint" className={controls.note}>
            {t('agents.editor.saveFirst')}
          </p>
        ) : null}
        {reviewer ? <p className={controls.note}>{t('agents.editor.reviewerNote')}</p> : null}
      </form>
      <p className={controls.ok} role="status" hidden={status === undefined}>
        {status === undefined ? '' : t(status)}
      </p>
    </section>
  )
}
