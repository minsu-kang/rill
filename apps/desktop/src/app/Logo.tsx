import { DOT_NODE, DROP_PATH, LOGO_VIEWBOX, SMALL_LOGO_MAX_SIZE, SPLIT_NODES, SPLIT_PATHS } from './logo-geometry'
import styles from './Logo.module.css'

export type LogoVariant = 'auto' | 'full' | 'small'

export interface LogoProps {
  size?: number
  variant?: LogoVariant
}

export function Logo({ size = 24, variant = 'auto' }: LogoProps) {
  const small = variant === 'small' || (variant === 'auto' && size <= SMALL_LOGO_MAX_SIZE)
  return (
    <svg
      className={styles.logo}
      width={size}
      height={size}
      viewBox={`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      data-rill-logo={small ? 'small' : 'full'}
    >
      <path className={styles.drop} d={DROP_PATH} />
      {small ? (
        <circle className={styles.inner} cx={DOT_NODE.cx} cy={DOT_NODE.cy} r={DOT_NODE.r} />
      ) : (
        <>
          {SPLIT_PATHS.map((d) => (
            <path key={d} className={styles.stroke} d={d} />
          ))}
          {SPLIT_NODES.map((node) => (
            <circle key={`${node.cx}-${node.cy}`} className={styles.inner} cx={node.cx} cy={node.cy} r={node.r} />
          ))}
        </>
      )}
    </svg>
  )
}
