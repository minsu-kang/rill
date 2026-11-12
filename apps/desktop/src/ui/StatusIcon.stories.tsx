import type { Meta, StoryObj } from '@storybook/react-vite'
import { NODE_STATUSES } from '../model/status'
import { StatusIcon } from './StatusIcon'

function Sheet() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 120px)', gap: 'var(--space-4)', padding: 'var(--space-4)', color: 'var(--text-primary)' }}>
      {[...NODE_STATUSES, 'retry' as const].map((kind) => (
        <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span style={{ transform: 'scale(2)', display: 'inline-flex', marginRight: 'var(--space-2)' }}>
            <StatusIcon kind={kind} label={kind} />
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>{kind}</span>
        </div>
      ))}
    </div>
  )
}

const meta = { title: 'UI/StatusIcon', component: StatusIcon, args: { kind: 'succeeded', label: 'Succeeded' } } satisfies Meta<typeof StatusIcon>

export default meta

type Story = StoryObj<typeof meta>

export const Single: Story = { argTypes: { kind: { control: 'select', options: [...NODE_STATUSES, 'retry'] } } }

export const AllIcons: Story = { name: 'All icons', render: () => <Sheet /> }
