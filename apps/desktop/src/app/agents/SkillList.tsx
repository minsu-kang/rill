import { SKILL_MAX_ITEMS, type Agent, type Skill } from '@rill/protocol'
import { plainText } from '../../chat/model/clamp'
import { agentsUsingSkill, skillSize } from '../../engine/skills'
import { useT } from '../../i18n'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import styles from './AgentsScreen.module.css'

export interface SkillListProps {
  skills: readonly Skill[]
  agents: readonly Agent[]
  selectedId: string | undefined
  creating: boolean
  onSelect(id: string): void
  onCreate(): void
  onImport?(): void
}

const SHOWN_AGENTS = 3

export function SkillList({ skills, agents, selectedId, creating, onSelect, onCreate, onImport }: SkillListProps) {
  const t = useT()
  const full = skills.length >= SKILL_MAX_ITEMS
  return (
    <div className={styles.listBox}>
      <div className={styles.listHead}>
        <span className={styles.count}>{t('skills.list.count', { count: skills.length, max: SKILL_MAX_ITEMS })}</span>
        <div className={styles.listButtons}>
          <button type="button" className={controls.primary} data-rill-new-skill="" disabled={full} aria-current={creating ? 'true' : undefined} onClick={onCreate}>
            {t('skills.list.new')}
          </button>
          {onImport === undefined ? null : (
            <button type="button" className={controls.button} data-rill-import-skill="" disabled={full} onClick={onImport}>
              {t('skills.import.button')}
            </button>
          )}
        </div>
      </div>
      {full ? (
        <p className={controls.warn} role="note">
          {t('skills.list.full', { max: SKILL_MAX_ITEMS })}
        </p>
      ) : null}
      <ul className={styles.list} aria-label={t('skills.list.label')}>
        {skills.map((skill) => {
          const users = agentsUsingSkill(agents, skill.id)
          const names = [...users.slice(0, SHOWN_AGENTS).map((agent) => plainText(agent.name, 30)), ...(users.length > SHOWN_AGENTS ? [t('skills.list.usedByMore', { count: users.length - SHOWN_AGENTS })] : [])]
          const selected = !creating && skill.id === selectedId
          return (
            <li key={skill.id}>
              <button type="button" className={styles.item} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(skill.id)}>
                <span className={styles.itemName}>
                  <SafeText text={skill.name} />
                </span>
                <span className={styles.itemMeta}>
                  <span className={styles.chip}>{t('skills.list.size', { count: skillSize(skill) })}</span>
                </span>
                <span className={styles.itemText}>
                  <SafeText text={skill.description} />
                </span>
                <span className={styles.itemFoot}>
                  <span className={styles.itemNote}>{users.length === 0 ? t('skills.list.unused') : t('skills.list.usedBy', { names: names.join(', ') })}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
