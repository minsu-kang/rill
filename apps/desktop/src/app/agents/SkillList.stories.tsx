import type { Agent, Skill } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { skillFixtures } from '../../fixtures/skills'
import { SkillList } from './SkillList'

const meta = { title: 'App/Agents/SkillList', component: SkillList } satisfies Meta<typeof SkillList>
export default meta
type Story = StoryObj<typeof meta>

const frame = (skills: Skill[], rest: { agents?: Agent[]; selectedId: string | undefined; creating?: boolean }) => ({
  skills,
  agents: rest.agents ?? [],
  selectedId: rest.selectedId,
  creating: rest.creating ?? false,
  onSelect: () => undefined,
  onCreate: () => undefined,
})

export const Empty: Story = { name: 'No skills', args: frame([], { selectedId: undefined, creating: true }) }

export const FewSkills: Story = { name: 'A few skills, one used', args: frame(skillFixtures.few, { agents: agentFixtures.skilled, selectedId: 'skill-slack' }) }

export const UsedByManyAgents: Story = {
  name: 'Used by more agents than fit',
  args: frame(skillFixtures.few, {
    agents: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...agentFixtures.few[0]!, id: `agent-${id}`, name: `Agent ${id}`, skillIds: ['skill-slack'] })),
    selectedId: 'skill-slack',
  }),
}

export const Creating: Story = { args: frame(skillFixtures.few, { selectedId: undefined, creating: true }) }

export const AtTheLimit: Story = { name: 'At the limit', args: frame(skillFixtures.full, { selectedId: 'skill-24' }) }

export const HostileNames: Story = {
  name: 'Hostile and long names',
  args: frame([...skillFixtures.hostile, ...skillFixtures.long], { agents: [{ ...agentFixtures.hostile[0]!, skillIds: ['skill-hostile'] }], selectedId: 'skill-hostile' }),
}
