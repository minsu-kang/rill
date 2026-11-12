import { flagKey, type Flag } from '@rill/protocol'
import { useT } from '../i18n'
import { ClampedText } from './ClampedText'
import { plainText } from './model/clamp'
import styles from './FlagConfirm.module.css'

export interface FlagConfirmProps {
  flags: readonly Flag[]
  confirmed: readonly string[]
  onToggle(key: string): void
  disabled?: boolean
  nodeTitles?: Readonly<Record<string, string>>
}

function groupsOf(flags: readonly Flag[]): Array<{ nodeId: string; flags: Flag[] }> {
  const groups: Array<{ nodeId: string; flags: Flag[] }> = []
  for (const flag of flags) {
    const group = groups.find((item) => item.nodeId === flag.nodeId)
    if (group === undefined) groups.push({ nodeId: flag.nodeId, flags: [flag] })
    else group.flags.push(flag)
  }
  return groups
}

export function FlagConfirm({ flags, confirmed, onToggle, disabled = false, nodeTitles }: FlagConfirmProps) {
  const t = useT()
  if (flags.length === 0) return null
  return (
    <div className={styles.root}>
      {groupsOf(flags).map((group) => {
        const title = nodeTitles !== undefined && Object.hasOwn(nodeTitles, group.nodeId) ? nodeTitles[group.nodeId] : undefined
        const name =
          title === undefined ? t('chat.flags.node', { node: plainText(group.nodeId) }) : t('chat.flags.nodeTitled', { node: plainText(group.nodeId), title: plainText(title) })
        return (
          <section key={group.nodeId} className={styles.group} aria-label={name}>
            <h5 className={styles.heading}>{name}</h5>
            <ul className={styles.list}>
              {group.flags.map((flag) => {
                const key = flagKey(flag)
                const code = t(`chat.flags.code.${flag.code}`)
                const pointer = plainText(flag.pointer, 120)
                return (
                  <li key={key} className={styles.flag}>
                    <div className={styles.details}>
                      <span className={styles.code}>{code}</span>
                      <code className={styles.pointer}>{pointer}</code>
                      <ClampedText text={flag.message} max={200} />
                    </div>
                    <label className={styles.confirm}>
                      <input type="checkbox" aria-label={t('chat.flags.confirmFor', { code, pointer })} checked={confirmed.includes(key)} disabled={disabled} onChange={() => onToggle(key)} />
                      <span aria-hidden="true">{t('chat.flags.confirm')}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
