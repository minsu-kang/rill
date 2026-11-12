import type { CSSProperties, ReactNode } from 'react'

export function TreeFrame({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div role="tree" aria-label={label} style={{ padding: 'var(--space-4)', ...style }}>
      {children}
    </div>
  )
}

export function Sized({ height, children }: { height: number; children: ReactNode }) {
  return <div style={{ height, padding: 'var(--space-3)' }}>{children}</div>
}
