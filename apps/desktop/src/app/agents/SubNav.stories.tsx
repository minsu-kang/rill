import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { SubNav, type SubNavItem } from './SubNav'

const meta = { title: 'App/Agents/SubNav', component: SubNav } satisfies Meta<typeof SubNav>
export default meta
type Story = StoryObj<typeof meta>

const TWO: SubNavItem[] = [
  { id: 'agents', label: 'agents.nav.agents' },
  { id: 'rules', label: 'agents.nav.rules' },
]

const THREE: SubNavItem[] = [...TWO, { id: 'hooks', label: 'agents.nav.hooks' }]

function Demo({ items, initial }: { items: SubNavItem[]; initial: string }) {
  const [current, setCurrent] = useState(initial)
  return (
    <div style={{ padding: 'var(--space-4)' }}>
      <SubNav label="agents.nav.label" items={items} current={current} onChange={setCurrent} />
    </div>
  )
}

const base = { label: 'agents.nav.label', items: TWO, current: 'agents', onChange: () => undefined } as const

export const AgentsCurrent: Story = { name: 'Agents is current', args: base, render: () => <Demo items={TWO} initial="agents" /> }

export const RulesCurrent: Story = { name: 'Rules is current', args: base, render: () => <Demo items={TWO} initial="rules" /> }

export const HooksCurrent: Story = { name: 'Hooks is current', args: { ...base, items: THREE, current: 'hooks' }, render: () => <Demo items={THREE} initial="hooks" /> }

export const MoreEntries: Story = {
  name: 'More entries than today',
  args: base,
  render: () => (
    <Demo
      items={[...TWO, { id: 'hooks', label: 'agents.nav.agents' }, { id: 'skills', label: 'agents.nav.rules' }]}
      initial="rules"
    />
  ),
}
