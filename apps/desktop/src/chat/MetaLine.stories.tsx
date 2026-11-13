import type { Meta, StoryObj } from '@storybook/react-vite'
import { metas } from '../fixtures/plan'
import { MetaLine } from './MetaLine'

const meta = {
  title: 'Chat/MetaLine',
  component: MetaLine,
  args: { meta: metas.plain },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MetaLine>

export default meta

type Story = StoryObj<typeof meta>

export const Plain: Story = {}

export const EffortLowered: Story = { name: 'Effort lowered by the model', args: { meta: metas.collapsed } }

export const CostUnknown: Story = { name: 'Cost unknown', args: { meta: metas.nullCost } }

export const NotesUsed: Story = { name: 'Notes used', args: { meta: metas.memory } }

export const NotesDropped: Story = { name: 'Notes left out', args: { meta: metas.memoryDropped } }

export const ReasoningCapped: Story = { name: 'Reasoning capped', args: { meta: metas.reasoningCapped } }

export const WithCostNote: Story = { name: 'With a cost note', args: { meta: metas.costNote } }

export const WithAgent: Story = { name: 'With an agent', args: { meta: metas.agent } }

export const AgentLeftOut: Story = { name: 'Agent settings left out', args: { meta: metas.agentDropped } }
