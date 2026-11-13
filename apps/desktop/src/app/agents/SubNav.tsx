import { useT, type MessageKey } from '../../i18n'
import styles from './SubNav.module.css'

export interface SubNavItem {
  id: string
  label: MessageKey
}

export interface SubNavProps {
  label: MessageKey
  items: readonly SubNavItem[]
  current: string
  onChange(id: string): void
}

export function SubNav({ label, items, current, onChange }: SubNavProps) {
  const t = useT()
  return (
    <nav className={styles.nav} aria-label={t(label)}>
      {items.map((item) => (
        <button key={item.id} type="button" className={styles.item} aria-current={item.id === current ? 'page' : undefined} onClick={() => onChange(item.id)}>
          {t(item.label)}
        </button>
      ))}
    </nav>
  )
}
