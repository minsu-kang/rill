import { AGENT_MAX_ITEMS, type Agent } from '@rill/protocol'
import { useT } from '../../i18n'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import styles from './AgentsScreen.module.css'

export interface AgentListProps {
  agents: readonly Agent[]
  activeId: string
  selectedId: string | undefined
  creating: boolean
  onSelect(id: string): void
  onCreate(): void
}

export function AgentList({ agents, activeId, selectedId, creating, onSelect, onCreate }: AgentListProps) {
  const t = useT()
  const saved = agents.filter((agent) => !agent.builtin).length
  const full = saved >= AGENT_MAX_ITEMS
  return (
    <div className={styles.listBox}>
      <div className={styles.listHead}>
        <span className={styles.count}>{t('agents.list.count', { count: saved, max: AGENT_MAX_ITEMS })}</span>
        <button type="button" className={controls.primary} data-rill-new-agent="" disabled={full} aria-current={creating ? 'true' : undefined} onClick={onCreate}>
          {t('agents.list.new')}
        </button>
      </div>
      {full ? (
        <p className={controls.warn} role="note">
          {t('agents.list.full', { max: AGENT_MAX_ITEMS })}
        </p>
      ) : null}
      <ul className={styles.list} aria-label={t('agents.list.label')}>
        {agents.map((agent) => {
          const selected = !creating && agent.id === selectedId
          return (
            <li key={agent.id}>
              <button type="button" className={styles.item} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(agent.id)}>
                <span className={styles.itemName}>{agent.builtin ? t('agents.default.name') : <SafeText text={agent.name} />}</span>
                <span className={styles.itemMeta}>
                  {agent.builtin ? <span className={styles.chip}>{t('agents.list.builtin')}</span> : null}
                  {agent.id === activeId ? <span className={styles.chipActive}>{t('agents.list.active')}</span> : null}
                </span>
                <span className={styles.itemText}>{agent.builtin ? t('agents.default.description') : <SafeText text={agent.description} />}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
