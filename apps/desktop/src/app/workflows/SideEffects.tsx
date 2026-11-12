import type { Workflow } from '@rill/dsl'
import type { NodeInfo } from '@rill/protocol'
import { useEffect, useMemo, useState } from 'react'
import type { EngineClient } from '../../engine/client'
import { useLocale, useT } from '../../i18n'
import { badgesOf, type BadgeKind } from '../../model/badges'
import { escapeInvisible, truncate } from '../../model/text'
import controls from '../controls.module.css'
import styles from './Workflows.module.css'

const MAX_TITLE = 60

export interface Effect {
  id: string
  title: string
  badges: BadgeKind[]
}

export type EffectsState = { status: 'loading' } | { status: 'error' } | { status: 'unknown' } | { status: 'ready'; effects: Effect[] }

interface Loaded {
  client: EngineClient
  workflowId: string
  workflow: Workflow | undefined
}

export function effectsOf(workflow: Workflow, catalog: readonly NodeInfo[]): EffectsState {
  const known = new Map(catalog.map((entry) => [entry.type, entry]))
  if (workflow.nodes.some((node) => !known.has(node.type))) return { status: 'unknown' }
  return {
    status: 'ready',
    effects: workflow.nodes.flatMap((node) => {
      const info = known.get(node.type)
      const badges = badgesOf(node.type, info)
      return badges.length === 0 ? [] : [{ id: node.id, title: info?.title ?? node.type, badges }]
    }),
  }
}

export function useSideEffects(client: EngineClient, workflowId: string, catalog: readonly NodeInfo[]): EffectsState {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined)

  useEffect(() => {
    let live = true
    client.request('getWorkflow', { workflowId }).then(
      ({ workflow }) => {
        if (live) setLoaded({ client, workflowId, workflow })
      },
      () => {
        if (live) setLoaded({ client, workflowId, workflow: undefined })
      },
    )
    return () => {
      live = false
    }
  }, [client, workflowId])

  const current = loaded !== undefined && loaded.client === client && loaded.workflowId === workflowId ? loaded : undefined
  return useMemo(() => {
    if (current === undefined) return { status: 'loading' }
    if (current.workflow === undefined) return { status: 'error' }
    return effectsOf(current.workflow, catalog)
  }, [current, catalog])
}

export function SideEffects({ state }: { state: EffectsState }) {
  const t = useT()
  const locale = useLocale()
  const list = useMemo(() => new Intl.ListFormat(locale, { type: 'conjunction', style: 'long' }), [locale])
  return (
    <div>
      <strong>{t('app.run.sideEffects')}</strong>
      {state.status === 'loading' ? <p className={controls.note}>{t('app.run.loadingEffects')}</p> : null}
      {state.status === 'error' ? <p className={controls.error}>{t('app.run.effectsError')}</p> : null}
      {state.status === 'unknown' ? <p className={controls.error}>{t('app.run.effectsUnknown')}</p> : null}
      {state.status === 'ready' && state.effects.length === 0 ? <p className={controls.note}>{t('app.run.noSideEffects')}</p> : null}
      {state.status === 'ready' && state.effects.length > 0 ? (
        <ul className={styles.effects}>
          {state.effects.map((effect) => (
            <li key={effect.id}>
              {t('app.run.effectLine', {
                title: truncate(escapeInvisible(effect.title), MAX_TITLE),
                id: truncate(escapeInvisible(effect.id), MAX_TITLE),
                badges: list.format(effect.badges.map((badge) => t(`badge.${badge}`))),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
