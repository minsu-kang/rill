import type { Meta, StoryObj } from '@storybook/react-vite'
import { useT } from '../i18n'
import { NODE_STATUSES, visualStatusOfRun, type RunStatusName } from '../model/status'
import { StatusChip } from './StatusChip'

const RUN_STATUSES: RunStatusName[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled']

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>{children}</div>
}

function NodeStatuses() {
  const t = useT()
  return (
    <Row>
      {NODE_STATUSES.map((status) => (
        <StatusChip key={status} status={status} label={t(`status.${status}`)} />
      ))}
    </Row>
  )
}

function RunStatuses() {
  const t = useT()
  return (
    <Row>
      {RUN_STATUSES.map((status) => (
        <StatusChip key={status} status={visualStatusOfRun(status)} label={t(`run.status.${status}`)} />
      ))}
    </Row>
  )
}

const meta = { title: 'UI/StatusChip', component: StatusChip, args: { status: 'running', label: 'Running' } } satisfies Meta<typeof StatusChip>

export default meta

type Story = StoryObj<typeof meta>

export const Single: Story = { argTypes: { status: { control: 'select', options: [...NODE_STATUSES] } } }

export const NodeStatusesStory: Story = { name: 'Node statuses', render: () => <NodeStatuses /> }

export const RunStatusesStory: Story = { name: 'Run statuses', render: () => <RunStatuses /> }
