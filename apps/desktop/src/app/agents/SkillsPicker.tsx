import { AGENT_MAX_SKILLS, AGENT_SKILLS_MAX_CHARS } from '@rill/protocol'
import { useId } from 'react'
import { skillSize, type SkillsState } from '../../engine/skills'
import { useT } from '../../i18n'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import styles from './AgentsScreen.module.css'
import { skillBudget } from './model/draft'

export interface SkillsPickerProps {
  skills: SkillsState
  value: readonly string[]
  disabled: boolean
  onChange(ids: string[]): void
  onRetry(): void
}

export function SkillsPicker({ skills, value, disabled, onChange, onRetry }: SkillsPickerProps) {
  const t = useT()
  const base = useId()
  const budget = skillBudget(value, skills.skills)
  const over = budget.chars > AGENT_SKILLS_MAX_CHARS
  const fits = (id: string, size: number): boolean => value.includes(id) || (budget.count < AGENT_MAX_SKILLS && budget.chars + size <= AGENT_SKILLS_MAX_CHARS)
  const limited = skills.skills.some((skill) => !fits(skill.id, skillSize(skill)))

  function toggle(id: string, checked: boolean): void {
    const next = new Set(value)
    if (checked) next.add(id)
    else next.delete(id)
    onChange(skills.skills.filter((skill) => next.has(skill.id)).map((skill) => skill.id))
  }

  return (
    <fieldset className={styles.picker}>
      <legend className={styles.label}>{t('agents.skills.legend')}</legend>
      <p className={styles.hint}>{t('agents.skills.hint', { maxSkills: AGENT_MAX_SKILLS, maxChars: AGENT_SKILLS_MAX_CHARS })}</p>
      {skills.status === 'loading' && skills.skills.length === 0 ? (
        <p className={controls.note} role="status">
          {t('agents.skills.loading')}
        </p>
      ) : null}
      {skills.status === 'error' && skills.skills.length === 0 ? (
        <div className={styles.pickError}>
          <p className={controls.error} role="alert">
            {t('agents.skills.loadError')}
          </p>
          <div className={controls.row}>
            <button type="button" className={controls.button} onClick={onRetry}>
              {t('agents.skills.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {skills.status === 'ready' && skills.skills.length === 0 ? <p className={controls.note}>{t('agents.skills.none')}</p> : null}
      {skills.skills.length > 0 ? (
        <>
          <div className={styles.meterRow}>
            <div
              className={styles.meter}
              role="meter"
              aria-label={t('agents.skills.meterLabel')}
              aria-valuemin={0}
              aria-valuemax={AGENT_SKILLS_MAX_CHARS}
              aria-valuenow={Math.min(budget.chars, AGENT_SKILLS_MAX_CHARS)}
              aria-valuetext={t('agents.skills.meter', { used: budget.chars, max: AGENT_SKILLS_MAX_CHARS })}
            >
              <div className={over ? styles.meterOver : styles.meterFill} style={{ width: `${Math.min(100, (budget.chars / AGENT_SKILLS_MAX_CHARS) * 100)}%` }} />
            </div>
            <p className={over ? styles.countOver : styles.counter}>{t('agents.skills.meter', { used: budget.chars, max: AGENT_SKILLS_MAX_CHARS })}</p>
            <p className={styles.counter}>{t('agents.skills.count', { count: budget.count, max: AGENT_MAX_SKILLS })}</p>
          </div>
          <ul className={styles.pickList}>
            {skills.skills.map((skill) => {
              const size = skillSize(skill)
              const checked = value.includes(skill.id)
              const room = fits(skill.id, size)
              const id = `${base}-${skill.id}`
              return (
                <li key={skill.id} className={styles.pickItem}>
                  <input id={id} type="checkbox" className={styles.pickBox} checked={checked} disabled={disabled || !room} aria-describedby={`${id}-info`} onChange={(event) => toggle(skill.id, event.target.checked)} />
                  <label htmlFor={id} className={styles.pickName}>
                    <SafeText text={skill.name} />
                  </label>
                  <span id={`${id}-info`} className={styles.pickInfo}>
                    <span className={styles.pickSize}>{t('agents.skills.size', { count: size })}</span>
                    {skill.description === '' ? null : (
                      <span className={styles.pickDescription}>
                        <SafeText text={skill.description} />
                      </span>
                    )}
                    {room ? null : <span className={styles.pickWarn}>{t('agents.skills.doesNotFit')}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
          {limited ? <p className={controls.note}>{t('agents.skills.limit')}</p> : null}
          <p className={controls.note}>{t('agents.skills.order')}</p>
        </>
      ) : null}
    </fieldset>
  )
}
