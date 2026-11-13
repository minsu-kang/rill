import type { LlmModelInfo, PlanEffort } from '@rill/protocol'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useLocale, useT } from '../i18n'
import { markHidden } from './model/clamp'
import { EFFORT_STEPS, stepAvailability, type EffortHint, type EffortStep } from './model/effort'
import { formatSeconds, formatUsd } from './model/format'
import styles from './EffortSlider.module.css'

export interface EffortSliderProps {
  value: PlanEffort
  onChange(effort: PlanEffort): void
  model: LlmModelInfo | undefined
  hints?: readonly EffortHint[]
  disabled?: boolean
  expanded?: boolean
  toggleHidden?: boolean
}

interface Entry {
  step: EffortStep
  enabled: boolean
  reason?: 'model_unsupported' | 'no_model'
}

export function EffortSlider({ value, onChange, model, hints, disabled = false, expanded: controlled, toggleHidden = false }: EffortSliderProps) {
  const t = useT()
  const locale = useLocale()
  const base = useId()
  const [own, setOwn] = useState(false)
  const expanded = controlled ?? own
  const refs = useRef(new Map<PlanEffort, HTMLButtonElement>())
  const showAdvanced = expanded || value === 'max'
  const entries: Entry[] = EFFORT_STEPS.filter((step) => !step.advanced || showAdvanced).map((step) => ({ step, ...stepAvailability(step, model) }))
  const usable = (entry: Entry): boolean => entry.enabled && !disabled
  const tabStop = entries.find((entry) => entry.step.effort === value && usable(entry)) ?? entries.find(usable)
  const current = entries.find((entry) => entry.step.effort === value)
  const stepName = (step: EffortStep): string => t(`chat.effort.${step.label}`)

  function choose(effort: PlanEffort): void {
    if (effort !== value) onChange(effort)
    refs.current.get(effort)?.focus()
  }

  function onKeyDown(event: KeyboardEvent, from: number): void {
    const indexes = entries.flatMap((entry, index) => (usable(entry) ? [index] : []))
    let target: number | undefined
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = indexes.find((index) => index > from)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        target = indexes.findLast((index) => index < from)
        break
      case 'Home':
        target = indexes[0]
        break
      case 'End':
        target = indexes.at(-1)
        break
      default:
        return
    }
    event.preventDefault()
    if (target !== undefined) choose(entries[target]!.step.effort)
  }

  const noModel = model === undefined
  const reasonId = (effort: PlanEffort): string => `${base}-reason-${effort}`
  const shownHints = (hints ?? []).filter((hint) => entries.some((entry) => entry.step.effort === hint.effort))
  const ordered = EFFORT_STEPS.flatMap((step) => shownHints.filter((hint) => hint.effort === step.effort).map((hint) => ({ step, hint })))

  function hintText(step: EffortStep, hint: EffortHint): string {
    const details: string[] = []
    if (hint.costUsd !== undefined) details.push(t('chat.effort.hintCost', { cost: formatUsd(hint.costUsd, locale) }))
    if (hint.latencyMs !== undefined) details.push(t('chat.effort.hintLatency', { seconds: formatSeconds(hint.latencyMs, locale) }))
    const basis = markHidden(hint.basis)
    return details.length === 0
      ? t('chat.effort.hintBasisOnly', { step: stepName(step), basis })
      : t('chat.effort.hint', { step: stepName(step), details: details.join(' · '), basis })
  }

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <div className={styles.group} role="radiogroup" aria-label={t('chat.effort.label')}>
          {entries.map((entry, index) => {
            const checked = entry.step.effort === value
            const blocked = !usable(entry)
            const described = entry.reason === undefined ? undefined : noModel ? `${base}-no-model` : reasonId(entry.step.effort)
            return (
              <button
                key={entry.step.effort}
                ref={(element) => {
                  if (element === null) refs.current.delete(entry.step.effort)
                  else refs.current.set(entry.step.effort, element)
                }}
                type="button"
                role="radio"
                className={styles.step}
                aria-checked={checked}
                aria-disabled={blocked ? true : undefined}
                aria-describedby={blocked ? described : undefined}
                tabIndex={tabStop === entry ? 0 : -1}
                onClick={() => {
                  if (!blocked) choose(entry.step.effort)
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {stepName(entry.step)}
              </button>
            )
          })}
        </div>
        {value === 'max' || toggleHidden ? null : (
          <button type="button" className={styles.toggle} aria-expanded={showAdvanced} disabled={disabled} onClick={() => setOwn(!expanded)}>
            {showAdvanced ? t('chat.effort.hideAdvanced') : t('chat.effort.showAdvanced')}
          </button>
        )}
      </div>
      {noModel ? (
        <p id={`${base}-no-model`} className={styles.note}>
          {t('chat.effort.reason.no_model')}
        </p>
      ) : (
        <ul className={styles.reasons}>
          {entries
            .filter((entry) => entry.reason === 'model_unsupported')
            .map((entry) => (
              <li key={entry.step.effort} id={reasonId(entry.step.effort)}>
                {t('chat.effort.disabledItem', { step: stepName(entry.step), reason: t('chat.effort.reason.model_unsupported') })}
              </li>
            ))}
        </ul>
      )}
      {current?.reason === 'model_unsupported' ? (
        <p className={styles.note} role="status">
          {t('chat.effort.willLower')}
        </p>
      ) : null}
      {ordered.length > 0 ? (
        <ul className={styles.hints} aria-label={t('chat.effort.hintsLabel')}>
          {ordered.map(({ step, hint }) => (
            <li key={`${step.effort}-${hint.basis}`}>{hintText(step, hint)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
