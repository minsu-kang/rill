import type { Meta, StoryObj } from '@storybook/react-vite'
import { builtinAgent } from '../../engine/fake-agents'
import { agentFixtures } from '../../fixtures/agents'
import { AgentEditor, type AgentEditorProps } from './AgentEditor'
import { draftOf, emptyDraft } from './model/draft'

const meta = { title: 'App/Agents/AgentEditor', component: AgentEditor } satisfies Meta<typeof AgentEditor>
export default meta
type Story = StoryObj<typeof meta>

const terse = agentFixtures.few[0]!

const base: AgentEditorProps = {
  agent: terse,
  creating: false,
  draft: draftOf(terse),
  dirty: false,
  inUse: false,
  busy: false,
  error: undefined,
  status: undefined,
  onChange: () => undefined,
  onSave: () => undefined,
  onRevert: () => undefined,
  onDelete: () => undefined,
  onUse: () => undefined,
}

export const SavedAgent: Story = { name: 'Saved agent', args: base }

export const AgentInUse: Story = { name: 'Agent in use', args: { ...base, inUse: true, status: 'agents.status.activated' } }

export const NewAgentEmpty: Story = { name: 'New agent, empty', args: { ...base, agent: undefined, creating: true, draft: emptyDraft() } }

export const WithProblems: Story = {
  name: 'With problems',
  args: { ...base, dirty: true, draft: { name: '', description: 'two\nlines', persona: 'tab\there', instructions: 'x'.repeat(3050) } },
}

export const Edited: Story = { name: 'Edited, not saved', args: { ...base, dirty: true, draft: { ...draftOf(terse), name: 'Terse reviewer, v2' } } }

export const Saving: Story = { args: { ...base, busy: true, dirty: true, draft: { ...draftOf(terse), name: 'Terse reviewer, v2' } } }

export const SaveError: Story = { name: 'Save error', args: { ...base, dirty: true, draft: { ...draftOf(terse), name: 'Plain tone only' }, error: 'chat.error.AGENT_DUPLICATE' } }

export const DefaultAgent: Story = { name: 'Default agent (read only)', args: { ...base, agent: builtinAgent(), draft: draftOf(builtinAgent()), inUse: true } }

export const DefaultNotInUse: Story = { name: 'Default agent, another is in use', args: { ...base, agent: builtinAgent(), draft: draftOf(builtinAgent()) } }

export const HostileName: Story = { name: 'Hostile name', args: { ...base, agent: agentFixtures.hostile[0]!, draft: draftOf(agentFixtures.hostile[0]!) } }
