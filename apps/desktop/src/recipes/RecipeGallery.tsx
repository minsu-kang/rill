import type { NodeInfo, RecipeInfo } from '@rill/protocol'
import { useId, useMemo, useState, type RefCallback } from 'react'
import { useLocale, useT } from '../i18n'
import { SafeText } from '../ui/SafeText'
import { allTags, filterRecipes, nodeTypeBase, sendsToModelProvider } from './model/filter'
import styles from './RecipeGallery.module.css'

export interface RecipeGalleryProps {
  recipes: readonly RecipeInfo[]
  status?: 'ready' | 'loading' | 'error'
  catalog?: readonly NodeInfo[]
  onChoose(recipeId: string): void
  onRetry?(): void
  headingRef?: RefCallback<HTMLElement>
}

const ICON_PATHS: Readonly<Record<string, string>> = {
  trigger: 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z',
  llm: 'M8 2l1.4 3.6L13 7l-3.6 1.4L8 12 6.6 8.4 3 7l3.6-1.4z',
  csv: 'M2.5 3.5h11v9h-11zM2.5 7h11M2.5 10h11M7 3.5v9',
  http: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11',
  notify: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3',
  condition: 'M4 3v10M4 8h5a3 3 0 0 0 3-3V3',
  other: 'M3 3h10v10H3z',
}

function iconFamily(type: string): string {
  const base = nodeTypeBase(type)
  if (base.startsWith('trigger.')) return 'trigger'
  if (base === 'condition') return 'condition'
  const family = base.split('.')[0] ?? ''
  return Object.hasOwn(ICON_PATHS, family) ? family : 'other'
}

function NodeTypeIcon({ type, title }: { type: string; title: string }) {
  return (
    <span className={styles.icon} role="img" aria-label={title} title={title}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d={ICON_PATHS[iconFamily(type)]} />
      </svg>
    </span>
  )
}

export function RecipeGallery({ recipes, status = 'ready', catalog = [], onChoose, onRetry, headingRef }: RecipeGalleryProps) {
  const t = useT()
  const locale = useLocale()
  const headingId = useId()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<readonly string[]>([])
  const everyTag = useMemo(() => allTags(recipes), [recipes])
  const shown = useMemo(() => filterRecipes(recipes, query, tags, locale), [recipes, query, tags, locale])

  const toggle = (tag: string): void => setTags((previous) => (previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag]))

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={headingRef === undefined ? undefined : -1} className={styles.heading}>
        {t('recipes.heading')}
      </h2>
      {status === 'loading' && (
        <p role="status" className={styles.message}>
          {t('recipes.loading')}
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className={styles.error}>
          <p className={styles.errorText}>{t('recipes.loadError')}</p>
          {onRetry !== undefined && (
            <button type="button" className={styles.button} onClick={onRetry}>
              {t('recipes.retry')}
            </button>
          )}
        </div>
      )}
      {status === 'ready' && recipes.length === 0 && <p className={styles.message}>{t('recipes.empty')}</p>}
      {status === 'ready' && recipes.length > 0 && (
        <>
          <div className={styles.filters}>
            <label htmlFor={searchId} className={styles.searchLabel}>
              {t('recipes.search')}
            </label>
            <input id={searchId} type="search" className={styles.search} value={query} placeholder={t('recipes.searchPlaceholder')} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
            {everyTag.length > 0 && (
              <div className={styles.tags} role="group" aria-label={t('recipes.tags')}>
                {everyTag.map((tag) => (
                  <button key={tag} type="button" className={styles.tag} aria-pressed={tags.includes(tag)} onClick={() => toggle(tag)}>
                    <SafeText text={tag} />
                  </button>
                ))}
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className={styles.message}>{t('recipes.noMatch')}</p>
          ) : (
            <ul className={styles.list}>
              {shown.map((recipe) => (
                <li key={recipe.id}>
                  <RecipeCard recipe={recipe} catalog={catalog} onChoose={onChoose} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function RecipeCard({ recipe, catalog, onChoose }: { recipe: RecipeInfo; catalog: readonly NodeInfo[]; onChoose(recipeId: string): void }) {
  const t = useT()
  const locale = useLocale()
  const titleId = useId()
  const title = recipe.title[locale]
  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>
        <SafeText text={title} />
      </h3>
      <p className={styles.description}>
        <SafeText text={recipe.description[locale]} />
      </p>
      <ul className={styles.icons} aria-label={t('recipes.card.steps')}>
        {recipe.nodeTypes.map((type, index) => (
          <li key={`${type}-${index}`}>
            <NodeTypeIcon type={type} title={catalog.find((node) => node.type === type)?.title ?? type} />
          </li>
        ))}
      </ul>
      <ul className={styles.tagList}>
        {recipe.tags.map((tag) => (
          <li key={tag} className={styles.tagItem}>
            <SafeText text={tag} />
          </li>
        ))}
      </ul>
      <div className={styles.notes}>
        {sendsToModelProvider(recipe) && <span className={styles.external}>{t('badge.externalTransfer')}</span>}
        {recipe.needsConnection && <span className={styles.note}>{t('recipes.card.needsConnection')}</span>}
      </div>
      <div>
        <button type="button" className={styles.button} aria-label={t('recipes.card.chooseLabel', { title })} onClick={() => onChoose(recipe.id)}>
          {t('recipes.card.choose')}
        </button>
      </div>
    </article>
  )
}
