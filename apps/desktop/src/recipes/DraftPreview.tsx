import type { NodeInfo, RecipeDraft } from '@rill/protocol'
import { useId } from 'react'
import { WorkflowGraph } from '../graph/WorkflowGraph'
import { useT, type MessageKey } from '../i18n'
import { NO_STATES } from '../model/status'
import { SafeText } from '../ui/SafeText'
import styles from './DraftPreview.module.css'
import type { DeployView } from './useRecipes'

export interface DraftPreviewProps {
  draft: RecipeDraft
  catalog: readonly NodeInfo[]
  deploy: DeployView
  onDeploy(): void
  onEdit(): void
  onAction?(action: 'activate' | 'dry_run', workflowId: string): void
  onDone?(): void
}

const EFFECT_KEYS: Readonly<Record<'idempotent' | 'external', MessageKey>> = {
  idempotent: 'recipes.preview.effect.idempotent',
  external: 'recipes.preview.effect.external',
}

export function DraftPreview({ draft, catalog, deploy, onDeploy, onEdit, onAction, onDone }: DraftPreviewProps) {
  const t = useT()
  const headingId = useId()
  const effects = draft.summary.sideEffects

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.heading}>
        {t('recipes.preview.heading')}
      </h3>
      <div className={styles.graph}>
        <WorkflowGraph workflow={draft.workflow} catalog={catalog} states={NO_STATES} />
      </div>
      <ul className={styles.effects} aria-label={t('recipes.preview.effects')}>
        {effects.length === 0 ? <li>{t('recipes.preview.effect.none')}</li> : effects.map((effect) => <li key={effect}>{t(EFFECT_KEYS[effect])}</li>)}
      </ul>
      {draft.summary.sendsToModel && (
        <div className={styles.transfer} role="note">
          <strong className={styles.transferTitle}>{t('badge.externalTransfer')}</strong>
          <span>{t('badge.externalTransfer.hint')}</span>
        </div>
      )}
      {deploy.phase === 'failed' && (
        <p role="alert" className={styles.failure}>
          {t(deploy.key)}
        </p>
      )}
      {deploy.phase === 'deployed' ? (
        <div className={styles.deployed}>
          <p role="status" className={styles.done}>
            <SafeText text={t('recipes.preview.deployed', { id: deploy.workflowId })} />
          </p>
          <p className={styles.hint}>{t('recipes.preview.notActive')}</p>
          <div className={styles.buttons}>
            <button type="button" className={styles.button} onClick={() => onAction?.('dry_run', deploy.workflowId)}>
              {t('recipes.preview.dryRun')}
            </button>
            <button type="button" className={styles.button} onClick={() => onAction?.('activate', deploy.workflowId)}>
              {t('recipes.preview.activate')}
            </button>
            <button type="button" className={styles.button} onClick={() => onDone?.()}>
              {t('recipes.preview.another')}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.buttons}>
          <button type="button" className={styles.primary} disabled={deploy.phase === 'deploying'} onClick={onDeploy}>
            {t(deploy.phase === 'deploying' ? 'recipes.preview.deploying' : 'recipes.preview.deploy')}
          </button>
          <button type="button" className={styles.button} disabled={deploy.phase === 'deploying'} onClick={onEdit}>
            {t('recipes.preview.edit')}
          </button>
        </div>
      )}
    </section>
  )
}
