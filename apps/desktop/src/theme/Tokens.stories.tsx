import type { Meta, StoryObj } from '@storybook/react-vite'
import styles from './Tokens.module.css'

const SURFACES = ['base', 'raised', 'sunken', 'overlay']
const TEXTS = ['primary', 'secondary', 'muted', 'accent']
const STATUSES = ['idle', 'running', 'succeeded', 'failed', 'abandoned', 'skipped', 'continued']
const BADGES = ['external', 'effect']
const EDGES = ['default', 'active']

function Tokens() {
  return (
    <div className={styles.page}>
      <section>
        <h2 className={styles.heading}>Surfaces and text</h2>
        <div className={styles.row}>
          {SURFACES.map((surface) => (
            <div key={surface} className={styles.chip} style={{ background: `var(--surface-${surface})` }}>
              <strong>surface-{surface}</strong>
              {TEXTS.map((text) => (
                <span key={text} className={styles.sample} style={{ color: `var(--text-${text})` }}>
                  text-{text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className={styles.heading}>Accent</h2>
        <div className={styles.row}>
          <div className={styles.chip} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            accent / on-accent
          </div>
          <div className={styles.chip} style={{ background: 'var(--accent-subtle)', color: 'var(--text-accent)' }}>
            accent-subtle / text-accent
          </div>
        </div>
      </section>
      <section>
        <h2 className={styles.heading}>Status</h2>
        <div className={styles.row}>
          {STATUSES.map((status) => (
            <div
              key={status}
              className={styles.chip}
              style={{
                background: `var(--status-${status}-bg)`,
                color: `var(--status-${status}-text)`,
                borderColor: `var(--status-${status}-border)`,
              }}
            >
              status-{status}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className={styles.heading}>Badges and edges</h2>
        <div className={styles.row}>
          {BADGES.map((badge) => (
            <div
              key={badge}
              className={styles.chip}
              style={{
                background: `var(--badge-${badge}-bg)`,
                color: `var(--badge-${badge}-text)`,
                borderColor: `var(--badge-${badge}-border)`,
              }}
            >
              badge-{badge}
            </div>
          ))}
          {EDGES.map((edge) => (
            <div key={edge} className={styles.edge} style={{ borderColor: `var(--edge-${edge})` }} title={`edge-${edge}`} />
          ))}
        </div>
      </section>
    </div>
  )
}

const meta = { title: 'Theme/Tokens', component: Tokens } satisfies Meta<typeof Tokens>

export default meta

export const Palette: StoryObj<typeof meta> = {}
