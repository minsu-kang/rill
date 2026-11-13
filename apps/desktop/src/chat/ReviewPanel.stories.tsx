import type { Meta, StoryObj } from '@storybook/react-vite'
import { reviewCases, reviewResultOf } from '../fixtures/review'
import { ReviewPanel } from './ReviewPanel'

const meta = { title: 'Chat/ReviewPanel', component: ReviewPanel } satisfies Meta<typeof ReviewPanel>
export default meta
type Story = StoryObj<typeof meta>

const frame = (args: Story['args']): Story => ({
  args,
  render: (given) => (
    <div style={{ width: 460, padding: 'var(--space-4)' }}>
      <ReviewPanel result={given.result} />
    </div>
  ),
})

export const Mixed: Story = frame({ result: reviewResultOf(reviewCases.mixed) })

export const NothingFound: Story = frame({ result: reviewResultOf(reviewCases.clean, { skillsUsed: 0, agentUsed: { id: 'agent-reviewer-ko', name: '꼼꼼한 검토자' } }) })

export const OnlyProblems: Story = frame({ result: reviewResultOf(reviewCases.onlyProblems) })

export const OnlyWarnings: Story = frame({ result: reviewResultOf(reviewCases.onlyWarnings) })

export const OnlyNotes: Story = frame({ result: reviewResultOf(reviewCases.onlyNotes) })

export const TenFindings: Story = frame({ result: reviewResultOf(reviewCases.many) })

export const WithCostNote: Story = frame({ result: reviewResultOf(reviewCases.mixed, { skillsUsed: 3, costNote: 'The price of cached prompt tokens is counted at the full input rate, so the real cost can be lower.' }) })

export const CostUnknownAndSettingsLeftOut: Story = { name: 'Cost unknown, reviewer settings left out', ...frame({ result: reviewResultOf(reviewCases.clean, { costUsd: null, agentDropped: 1, skillsUsed: 0 }) }) }

export const HostileText: Story = {
  name: 'Hostile text',
  ...frame({ result: reviewResultOf(reviewCases.hostile, { agentUsed: { id: 'x', name: '<b>Evil reviewer</b> \u202egpj' }, provider: '<img src=x>', model: 'model\u200b-name' }) }),
}
