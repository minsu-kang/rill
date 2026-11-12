import type { RecipeParamInfo } from '@rill/protocol'
import { useEffect, useId, useRef } from 'react'
import { useLocale, useT, type MessageKey } from '../i18n'
import { SafeText } from '../ui/SafeText'
import styles from './FieldInput.module.css'
import { visibleConnections, type HostConnection } from './model/values'

export interface FieldInputProps {
  param: RecipeParamInfo
  value: string
  error?: MessageKey
  raw?: string
  connections: readonly HostConnection[]
  onChange(value: string): void
  onPickPath?(kind: 'folder' | 'file'): Promise<string | undefined>
}

const CRON_PRESETS: ReadonlyArray<{ value: string; key: MessageKey }> = [
  { value: '0 9 * * 1-5', key: 'recipes.cron.weekdays' },
  { value: '0 9 1 * *', key: 'recipes.cron.monthly' },
  { value: '0 9 * * *', key: 'recipes.cron.daily' },
  { value: '0 9 * * 1', key: 'recipes.cron.weekly' },
  { value: '0 * * * *', key: 'recipes.cron.hourly' },
]

const TEMPLATE = /\{\{|\}\}/

export function FieldInput({ param, value, error, raw, connections, onChange, onPickPath }: FieldInputProps) {
  const t = useT()
  const locale = useLocale()
  const id = useId()
  const helpId = `${id}-help`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const label = param.label[locale]
  const help = param.help?.[locale]
  const matching = visibleConnections(param, connections)
  const hint = rangeHint(t, param)
  const shownError = error ?? (param.kind !== 'number' && TEMPLATE.test(value) ? 'recipes.rule.template_text' : undefined)
  const describedBy = [help === undefined ? undefined : helpId, hint === undefined ? undefined : hintId, shownError === undefined ? undefined : errorId].filter((item) => item !== undefined).join(' ')
  const common = { id, value, 'aria-invalid': shownError === undefined ? undefined : true, 'aria-required': param.required ? true : undefined, 'aria-describedby': describedBy === '' ? undefined : describedBy }
  const pickerKind = param.kind === 'folder' || param.kind === 'file' ? param.kind : undefined
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const pick = async (kind: 'folder' | 'file'): Promise<void> => {
    try {
      const picked = await onPickPath?.(kind)
      if (picked !== undefined && mounted.current) onChange(picked)
    } catch {
      return
    }
  }

  const noConnection = param.kind === 'connection' && matching.length === 0

  return (
    <div className={styles.root}>
      <div className={styles.labelRow}>
        {noConnection ? (
          <span className={styles.label}>
            <SafeText text={label} />
          </span>
        ) : (
          <label htmlFor={id} className={styles.label}>
            <SafeText text={label} />
          </label>
        )}
        {param.required && <span className={styles.marker}>{t('recipes.form.required')}</span>}
      </div>
      {help !== undefined && (
        <p id={helpId} className={styles.help}>
          <SafeText text={help} />
        </p>
      )}
      {noConnection ? (
        <p className={styles.notice} role="status">
          {param.connectionKind === undefined ? t('recipes.field.noConnectionAny') : t('recipes.field.noConnection', { kind: t(`recipes.kind.${param.connectionKind}`) })}
        </p>
      ) : param.kind === 'connection' ? (
        <select {...common} className={styles.control} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('recipes.field.connectionPick')}</option>
          {matching.map((connection) => (
            <option key={connection.name} value={connection.name}>
              {connection.name}
            </option>
          ))}
        </select>
      ) : (
        <div className={styles.inputRow}>
          <input
            {...common}
            type="text"
            className={styles.control}
            inputMode={param.kind === 'number' ? 'decimal' : param.kind === 'url' ? 'url' : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
          {pickerKind !== undefined && onPickPath !== undefined && (
            <button type="button" className={styles.button} aria-label={`${label} ${t('recipes.field.choose')}`} onClick={() => void pick(pickerKind)}>
              {t('recipes.field.choose')}
            </button>
          )}
        </div>
      )}
      {param.kind === 'cron' && (
        <>
          <label className={styles.presetRow}>
            <span className={styles.presetLabel}>{t('recipes.field.cronPreset')}</span>
            <select className={styles.control} value={CRON_PRESETS.find((preset) => preset.value === value)?.value ?? ''} onChange={(event) => event.target.value !== '' && onChange(event.target.value)}>
              <option value="">{t('recipes.field.cronCustom')}</option>
              {CRON_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {t(preset.key)}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.hint}>{t('recipes.field.cronNote')}</p>
        </>
      )}
      {hint !== undefined && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {param.kind === 'file' && param.extension !== undefined && <p className={styles.hint}>{t('recipes.field.extension', { extension: param.extension })}</p>}
      {shownError !== undefined && (
        <p id={errorId} className={styles.error}>
          {t(shownError)}
          {raw !== undefined && (
            <small className={styles.raw}>
              {' '}
              <SafeText text={t('recipes.field.rawRule', { rule: raw })} />
            </small>
          )}
        </p>
      )}
    </div>
  )
}

function rangeHint(t: ReturnType<typeof useT>, param: RecipeParamInfo): string | undefined {
  if (param.kind !== 'number') return undefined
  if (param.min !== undefined && param.max !== undefined) return t('recipes.field.range', { min: param.min, max: param.max })
  if (param.min !== undefined) return t('recipes.field.rangeMin', { min: param.min })
  if (param.max !== undefined) return t('recipes.field.rangeMax', { max: param.max })
  return undefined
}
