import type { Agent } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { builtinAgent } from '../../engine/fake-agents'
import { AgentList } from './AgentList'

const meta = { title: 'App/Agents/AgentList', component: AgentList } satisfies Meta<typeof AgentList>
export default meta
type Story = StoryObj<typeof meta>

const frame = (list: Agent[], rest: { activeId: string; selectedId: string | undefined; creating?: boolean }) => ({
  agents: [builtinAgent(), ...list],
  activeId: rest.activeId,
  selectedId: rest.selectedId,
  creating: rest.creating ?? false,
  onSelect: () => undefined,
  onCreate: () => undefined,
})

export const OnlyDefault: Story = { name: 'Only Default', args: frame([], { activeId: 'default', selectedId: 'default' }) }

export const FewAgents: Story = { name: 'A few agents, one in use', args: frame(agentFixtures.few, { activeId: 'agent-terse', selectedId: 'agent-ko' }) }

export const Creating: Story = { args: frame(agentFixtures.few, { activeId: 'default', selectedId: undefined, creating: true }) }

export const AtTheLimit: Story = { name: 'At the limit', args: frame(agentFixtures.twelve, { activeId: 'agent-01', selectedId: 'agent-12' }) }

export const HostileNames: Story = { name: 'Hostile and long names', args: frame([...agentFixtures.hostile, ...agentFixtures.long], { activeId: 'agent-long', selectedId: 'agent-hostile' }) }

export const KindsAndSkills: Story = {
  name: 'Assistants, reviewers and skills',
  args: frame([...agentFixtures.few, ...agentFixtures.skilled, ...agentFixtures.reviewers], { activeId: 'agent-skilled', selectedId: 'agent-reviewer' }),
}

export const ReviewerSelected: Story = {
  name: 'A reviewer is selected',
  args: frame([...agentFixtures.skilled, ...agentFixtures.reviewers], { activeId: 'default', selectedId: 'agent-reviewer' }),
}
