import type { LlmModelsResult } from '@rill/protocol'
import { useEffect, useState } from 'react'
import { ModelPicker } from '../../chat/ModelPicker'
import type { EngineClient } from '../../engine/client'
import { useT } from '../../i18n'
import { escapeInvisible } from '../../model/text'
import type { ProviderId } from '../../shared/host-api'
import controls from '../controls.module.css'
import type { ConnectionState } from '../connection'
import { useHost } from '../host'
import styles from './Settings.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

export interface ModelSectionProps {
  api: SettingsApi
  client: EngineClient | undefined
  connection: Pick<ConnectionState, 'state' | 'status'>
  onGoKeys?(): void
}

type Loaded = { client: EngineClient; models: LlmModelsResult } | { client: EngineClient; failed: true }

export function ModelSection({ api, client, connection, onGoKeys }: ModelSectionProps) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined)

  useEffect(() => {
    if (client === undefined) return undefined
    let live = true
    client.request('llmModels', {}).then(
      (models) => {
        if (live) setLoaded({ client, models })
      },
      () => {
        if (live) setLoaded({ client, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [client])

  const current = loaded !== undefined && loaded.client === client ? loaded : undefined
  const models = current !== undefined && 'models' in current ? current.models : undefined
  const restarting = connection.status?.state === 'restarting' || connection.state === 'reconnecting'
  const active = models?.active === null || models?.active === undefined ? undefined : models.models.find((item) => item.provider === models.active?.provider && item.id === models.active.model)

  function select(choice: { provider: ProviderId; model: string }): void {
    void action.run(async () => {
      api.apply(await host.settings.update({ provider: choice.provider, model: choice.model }))
    })
  }

  return (
    <section className={styles.panel} aria-label={t('app.settings.section.model')}>
      <p className={controls.note}>{t('app.model.intro')}</p>
      <section className={controls.warn} role="note" aria-label={t('app.model.transfer.heading')}>
        <span className={controls.badge}>{t('badge.externalTransfer')}</span> <strong>{t('app.model.transfer.heading')}</strong>
        <p className={controls.note}>{t('app.model.transfer.body')}</p>
      </section>
      {restarting ? (
        <p className={controls.note} role="status">
          {t('app.model.restarting')}
        </p>
      ) : null}
      {client === undefined ? (
        <p className={controls.note}>{t('app.model.notConnected')}</p>
      ) : current === undefined ? (
        <p className={controls.note}>{t('app.model.loading')}</p>
      ) : models === undefined ? (
        <p className={controls.error} role="alert">
          {t('app.model.loadError')}
        </p>
      ) : (
        <>
          {models.active === null ? (
            <div className={controls.row}>
              <p className={controls.note}>{t('app.model.noneActive')}</p>
              {onGoKeys === undefined ? null : (
                <button type="button" className={controls.button} onClick={onGoKeys}>
                  {t('app.model.goKeys')}
                </button>
              )}
            </div>
          ) : (
            <p className={controls.note}>{t('app.model.active', { model: escapeInvisible(active?.label ?? models.active.model) })}</p>
          )}
          <ModelPicker models={models} onSelect={action.busy ? undefined : select} />
        </>
      )}
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </section>
  )
}
