import type { RunSummary } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fixtureRuns, FIXTURE_NOW, ids } from '../fixtures'
import { RunHistory } from './RunHistory'

const STATUSES: RunSummary['status'][] = ['queued', 'running', 'succeeded', 'failed', 'cancelled']

function generated(count: number): RunSummary[] {
  return Array.from({ length: count }, (_, index): RunSummary => {
    const status = STATUSES[index % STATUSES.length]!
    const createdAt = FIXTURE_NOW - index * 47 * 60_000
    return {
      id: `run-generated-${String(index).padStart(3, '0')}`,
      workflowId: ids.workflows.receipt,
      status,
      dryRun: index % 7 === 3,
      error: status === 'failed' ? `node extract failed: provider error: 503 (attempt ${index})` : null,
      createdAt,
      startedAt: createdAt,
      finishedAt: status === 'succeeded' || status === 'failed' ? createdAt + 60_000 : null,
    }
  })
}

const meta = {
  title: 'Runs/RunHistory',
  component: RunHistory,
  args: { runs: fixtureRuns, now: FIXTURE_NOW, timeZone: 'Asia/Seoul' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720, height: 420, padding: 'var(--space-3)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunHistory>

export default meta

type Story = StoryObj<typeof meta>

export const AllStatuses: Story = {}

export const WithSelection: Story = { args: { selectedRunId: ids.runs.receiptFailed } }

export const Empty: Story = { args: { runs: [] } }

export const ManyRuns: Story = { args: { runs: generated(60), selectedRunId: 'run-generated-004' } }

export const HostileError: Story = {
  args: { runs: [{ ...fixtureRuns[6]!, error: '<img src=x onerror=alert(1)> <script>alert(2)</script> ' + 'long '.repeat(80) }] },
}
