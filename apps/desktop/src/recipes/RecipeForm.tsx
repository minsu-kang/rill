import type { RecipeInfo, RecipeValues } from '@rill/protocol'
import { useMemo, useState, type FormEvent, type RefCallback } from 'react'
import { useLocale, useT, type MessageKey } from '../i18n'
import { SafeText } from '../ui/SafeText'
import { useKeepFocus } from '../ui/useKeepFocus'
import { FieldInput } from './FieldInput'
import { problemsToFields } from './model/problems'
import { toRequestValues, valueErrorKey, valueOf, withVisibleConnections, type FormValues, type HostConnection, type ValueError } from './model/values'
import styles from './RecipeForm.module.css'

export interface RecipeFormProps {
  recipe: RecipeInfo
  values: FormValues
  onValuesChange(update: (previous: FormValues) => FormValues): void
  connections: readonly HostConnection[]
  onPickPath?(kind: 'folder' | 'file'): Promise<string | undefined>
  submitting?: boolean
  problems?: readonly string[]
  failureKey?: MessageKey
  onSubmit(values: RecipeValues): void
  onBack(): void
  headingRef?: RefCallback<HTMLElement>
}

const NO_PROBLEMS: readonly string[] = []

function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

export function RecipeForm({ recipe, values, onValuesChange, connections, onPickPath, submitting = false, problems = NO_PROBLEMS, failureKey, onSubmit, onBack, headingRef }: RecipeFormProps) {
  const t = useT()
  const locale = useLocale()
  useKeepFocus(submitting)
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, ValueError>>>({})
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set())
  const server = useMemo(() => problemsToFields(problems, recipe.params), [problems, recipe.params])
  const shown = useMemo(() => withVisibleConnections(recipe.params, values, connections), [recipe.params, values, connections])
  const complete = recipe.params.every((param) => param.default !== undefined || valueOf(shown, param.id).trim() !== '')

  const change = (id: string, value: string): void => {
    onValuesChange((previous) => ({ ...previous, [id]: value }))
    setEdited((previous) => new Set(previous).add(id))
    setClientErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)))
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (submitting) return
    const checked = toRequestValues(recipe.params, shown)
    if (!checked.ok) {
      setClientErrors(checked.errors)
      return
    }
    setClientErrors({})
    setEdited(new Set())
    onSubmit(checked.values)
  }

  const errorOf = (id: string): MessageKey | undefined => {
    const client = ownEntry(clientErrors, id)
    if (client !== undefined) return valueErrorKey(client)
    return edited.has(id) ? undefined : ownEntry(server.fields, id)
  }

  return (
    <form className={styles.root} noValidate onSubmit={submit}>
      <div className={styles.top}>
        <button type="button" className={styles.link} onClick={onBack}>
          {t('recipes.form.back')}
        </button>
        <h3 ref={headingRef} tabIndex={headingRef === undefined ? undefined : -1} className={styles.heading}>
          <SafeText text={t('recipes.form.heading', { title: recipe.title[locale] })} />
        </h3>
        <p className={styles.description}>
          <SafeText text={recipe.description[locale]} />
        </p>
      </div>
      {failureKey !== undefined && (
        <p role="alert" className={styles.failure}>
          {t(failureKey)}
        </p>
      )}
      {server.general.length > 0 && (
        <div role="alert" className={styles.failure}>
          <ul className={styles.problems} aria-label={t('recipes.form.general')}>
            {server.general.map((problem, index) => (
              <li key={index} className={styles.problem}>
                <span>{t(problem.key)}</span>{' '}
                <code className={styles.code}>
                  <SafeText text={problem.pointer === '' ? problem.code : `${problem.code} · ${problem.pointer}`} />
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.fields}>
        {recipe.params.map((param) => (
          <FieldInput
            key={param.id}
            param={param}
            value={valueOf(shown, param.id)}
            error={errorOf(param.id)}
            raw={edited.has(param.id) ? undefined : ownEntry(server.raw, param.id)}
            connections={connections}
            onChange={(value) => change(param.id, value)}
            onPickPath={onPickPath}
          />
        ))}
      </div>
      <div>
        <button type="submit" className={styles.primary} disabled={!complete || submitting}>
          {t(submitting ? 'recipes.form.submitting' : 'recipes.form.submit')}
        </button>
      </div>
    </form>
  )
}
