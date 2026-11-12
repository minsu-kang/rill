import type { LlmModelInfo, LlmModelsResult, LlmProviderStatus, ProviderId } from '@rill/protocol'
import { useId } from 'react'
import { useLocale, useT } from '../i18n'
import { ClampedText } from './ClampedText'
import { markHidden } from './model/clamp'
import { localeTag } from './model/format'
import styles from './ModelPicker.module.css'

export interface ModelPickerProps {
  models: LlmModelsResult
  onSelect?(choice: { provider: ProviderId; model: string }): void
}

const NOTE_CAP = 160

function ProviderGroup({ provider, models, active, onSelect }: { provider: LlmProviderStatus; models: readonly LlmModelInfo[]; active: LlmModelsResult['active']; onSelect: ModelPickerProps['onSelect'] }) {
  const t = useT()
  const locale = useLocale()
  const tokens = new Intl.NumberFormat(localeTag(locale))
  const providerNote = models[0]?.capabilities.dataNote
  return (
    <section className={styles.provider} role="group" aria-label={markHidden(provider.label)}>
      <h4 className={styles.heading}>
        {markHidden(provider.label)}
        {provider.configured ? null : <span className={styles.badge}>{t('chat.model.keyNeeded')}</span>}
      </h4>
      {provider.configured ? null : <p className={styles.hint}>{t('chat.model.keyHint', { env: markHidden(provider.keyEnv) })}</p>}
      <div className={styles.models}>
        {models.map((model) => {
          const isActive = active !== null && active.provider === model.provider && active.model === model.id
          return (
            <div key={model.id} className={styles.entry}>
              <button
                type="button"
                className={styles.model}
                aria-current={isActive ? 'true' : undefined}
                aria-disabled={provider.configured ? undefined : true}
                onClick={() => {
                  if (provider.configured && !isActive) onSelect?.({ provider: model.provider, model: model.id })
                }}
              >
                <span className={styles.name}>{markHidden(model.label)}</span>
                <span className={styles.meta}>{t(`chat.model.tier.${model.tier}`)}</span>
                <span className={styles.meta}>{t('chat.model.context', { tokens: tokens.format(model.contextTokens) })}</span>
                {isActive ? <span className={styles.activeMark}>{t('chat.model.active')}</span> : null}
              </button>
              {model.capabilities.dataNote !== providerNote ? (
                <p className={styles.note}>
                  <strong>{t('chat.model.dataNote')}</strong> <ClampedText text={model.capabilities.dataNote} max={NOTE_CAP} />
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
      {providerNote === undefined ? null : (
        <p className={styles.note}>
          <strong>{t('chat.model.dataNote')}</strong> <ClampedText text={providerNote} max={NOTE_CAP} />
        </p>
      )}
    </section>
  )
}

export function ModelPicker({ models, onSelect }: ModelPickerProps) {
  const t = useT()
  const heading = useId()
  return (
    <section className={styles.root} aria-labelledby={heading}>
      <h3 id={heading} className={styles.title}>
        {t('chat.model.label')}
      </h3>
      <p className={styles.hint}>{t('chat.model.switchHint')}</p>
      {models.models.length === 0 ? (
        <p className={styles.hint}>{t('chat.model.empty')}</p>
      ) : (
        models.providers.map((provider) => (
          <ProviderGroup key={provider.id} provider={provider} models={models.models.filter((model) => model.provider === provider.id)} active={models.active} onSelect={onSelect} />
        ))
      )}
    </section>
  )
}
