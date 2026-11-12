import { flagKey, type NodeInfo, type PatchOp } from '@rill/protocol'
import { useT, type MessageKey, type Translate } from '../i18n'
import { WorkflowGraph } from '../graph/WorkflowGraph'
import { NO_STATES } from '../model/status'
import { ClampedText } from './ClampedText'
import { ErrorNotice } from './ErrorNotice'
import { FlagConfirm } from './FlagConfirm'
import { plainText } from './model/clamp'
import { canDeploy, type AssistantEntry } from './model/conversation'
import styles from './PlanResultCard.module.css'

export interface PlanResultCardProps {
  entry: AssistantEntry
  catalog: readonly NodeInfo[]
  confirmed: readonly string[]
  onToggleFlag(key: string): void
  onDeploy(): void
  deploying: boolean
  deployError?: MessageKey
}

const MAX_PATCH_ROWS = 50
const MAX_KEYS = 8

function describePatch(t: Translate, op: PatchOp): string {
  switch (op.op) {
    case 'add_node':
      return t('chat.patch.add_node', { node: plainText(op.node.id), type: plainText(op.node.type) })
    case 'set_config': {
      const names = [...Object.keys(op.config), ...(op.retry === undefined ? [] : ['retry']), ...(op.onError === undefined ? [] : ['onError'])]
      const shown = names.slice(0, MAX_KEYS).map((name) => plainText(name, 30))
      return t('chat.patch.set_config', { node: plainText(op.nodeId), keys: names.length > MAX_KEYS ? `${shown.join(', ')}, …` : shown.join(', ') })
    }
    case 'remove_node':
      return t('chat.patch.remove_node', { node: plainText(op.nodeId) })
    case 'connect':
      return op.edge.when === undefined
        ? t('chat.patch.connect', { from: plainText(op.edge.from), to: plainText(op.edge.to) })
        : t('chat.patch.connectWhen', { from: plainText(op.edge.from), to: plainText(op.edge.to), when: plainText(op.edge.when) })
    case 'disconnect':
      return t('chat.patch.disconnect', { from: plainText(op.from), to: plainText(op.to) })
  }
}

export function PlanResultCard({ entry, catalog, confirmed, onToggleFlag, onDeploy, deploying, deployError }: PlanResultCardProps) {
  const t = useT()
  const { result } = entry
  if (result.kind !== 'workflow') return null
  const flags = result.flags
  const deployed = entry.deployed !== undefined
  const ready = canDeploy(entry, confirmed)
  const done = flags.filter((flag) => confirmed.includes(flagKey(flag))).length
  const titles: Record<string, string> = {}
  for (const node of result.workflow.nodes) {
    const info = catalog.find((item) => item.type === node.type)
    if (info !== undefined) titles[node.id] = info.title
  }
  const patch = result.patch ?? []
  return (
    <div className={styles.card} data-plan-card="">
      <p className={styles.summary}>
        <ClampedText text={result.summary} max={400} />
      </p>
      {patch.length === 0 ? null : (
        <div className={styles.patch}>
          <h4 className={styles.heading}>{t('chat.patch.heading')}</h4>
          <ul className={styles.list} aria-label={t('chat.patch.heading')}>
            {patch.slice(0, MAX_PATCH_ROWS).map((op, index) => (
              <li key={index}>{describePatch(t, op)}</li>
            ))}
            {patch.length > MAX_PATCH_ROWS ? <li>{t('chat.patch.more', { count: patch.length - MAX_PATCH_ROWS })}</li> : null}
          </ul>
        </div>
      )}
      <div className={styles.graph} role="region" aria-label={t('chat.graph.label')}>
        <WorkflowGraph workflow={result.workflow} catalog={catalog} states={NO_STATES} />
      </div>
      {flags.length === 0 ? null : (
        <>
          <p className={styles.banner} role="note">
            {t('chat.flags.banner', { count: flags.length })}
          </p>
          <FlagConfirm flags={flags} confirmed={confirmed} onToggle={onToggleFlag} disabled={deploying || deployed} nodeTitles={titles} />
        </>
      )}
      <div className={styles.deploy}>
        {deployed ? (
          <p className={styles.done} role="status">
            {t('chat.deploy.done', { id: plainText(entry.deployed!, 80) })}
          </p>
        ) : (
          <>
            <button type="button" className={styles.button} disabled={!ready || deploying} onClick={onDeploy}>
              {deploying ? t('chat.deploy.deploying') : t('chat.deploy.button')}
            </button>
            {flags.length > 0 ? <span className={styles.progress}>{t('chat.flags.progress', { done, total: flags.length })}</span> : null}
            {flags.length > 0 && !ready && !deploying ? <span className={styles.progress}>{t('chat.deploy.blocked')}</span> : null}
          </>
        )}
      </div>
      {deployError === undefined ? null : <ErrorNotice messageKey={deployError} />}
    </div>
  )
}
