import type { Meta, StoryObj } from '@storybook/react-vite'
import { explainCases } from '../fixtures/explain'
import { FixProposal } from './FixProposal'

const meta = {
  title: 'Explain/FixProposal',
  component: FixProposal,
  args: { proposal: explainCases.configuration.fixProposal!, onPropose: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FixProposal>

export default meta

type Story = StoryObj<typeof meta>

export const Plain: Story = {}

export const WithHiddenMarker: Story = { args: { proposal: explainCases.hiddenText.fixProposal! } }

export const LongText: Story = { args: { proposal: { nodeId: 'extract', requestText: '이 노드의 설정을 바꿔 주세요. '.repeat(25).slice(0, 400) } } }

export const HostileText: Story = { args: { proposal: explainCases.hostile.fixProposal! } }
