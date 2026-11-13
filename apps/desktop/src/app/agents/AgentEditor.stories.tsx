import type { Meta, StoryObj } from '@storybook/react-vite'
import { builtinAgent } from '../../engine/fake-agents'
import { agentFixtures } from '../../fixtures/agents'
import { skillFixtures } from '../../fixtures/skills'
import { AgentEditor, type AgentEditorProps } from './AgentEditor'
import { draftOf, emptyDraft } from './model/draft'

const meta = { title: 'App/Agents/AgentEditor', component: AgentEditor } satisfies Meta<typeof AgentEditor>
export default meta
type Story = StoryObj<typeof meta>

const terse = agentFixtures.few[0]!
const skilled = agentFixtures.skilled[0]!
const reviewer = agentFixtures.reviewers[0]!

const base: AgentEditorProps = {
  agent: terse,
  creating: false,
  draft: draftOf(terse),
  dirty: false,
  inUse: false,
  busy: false,
  error: undefined,
  status: undefined,
  skills: { status: 'ready', skills: skillFixtures.few },
  onChange: () => undefined,
  onKind: () => undefined,
  onSkills: () => undefined,
  onRetrySkills: () => undefined,
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
  args: { ...base, dirty: true, draft: { ...emptyDraft(), name: '', description: 'two\nlines', persona: 'tab\there', instructions: 'x'.repeat(3050) } },
}

export const Edited: Story = { name: 'Edited, not saved', args: { ...base, dirty: true, draft: { ...draftOf(terse), name: 'Terse reviewer, v2' } } }

export const Saving: Story = { args: { ...base, busy: true, dirty: true, draft: { ...draftOf(terse), name: 'Terse reviewer, v2' } } }

export const SaveError: Story = { name: 'Save error', args: { ...base, dirty: true, draft: { ...draftOf(terse), name: 'Plain tone only' }, error: 'chat.error.AGENT_DUPLICATE' } }

export const DefaultAgent: Story = { name: 'Default agent (read only)', args: { ...base, agent: builtinAgent(), draft: draftOf(builtinAgent()), inUse: true } }

export const DefaultNotInUse: Story = { name: 'Default agent, another is in use', args: { ...base, agent: builtinAgent(), draft: draftOf(builtinAgent()) } }

export const HostileName: Story = { name: 'Hostile name', args: { ...base, agent: agentFixtures.hostile[0]!, draft: draftOf(agentFixtures.hostile[0]!) } }

export const WithSkills: Story = { name: 'With two skills', args: { ...base, agent: skilled, draft: draftOf(skilled) } }

export const SkillsChangedNotSaved: Story = { name: 'Skills changed, not saved', args: { ...base, agent: skilled, dirty: true, draft: { ...draftOf(skilled), skillIds: ['skill-receipts', 'skill-slack', 'skill-ko'] } } }

export const ReviewerAgent: Story = { name: 'A reviewer', args: { ...base, agent: reviewer, draft: draftOf(reviewer) } }

export const KindChangedNotSaved: Story = { name: 'Kind changed to reviewer, not saved', args: { ...base, dirty: true, draft: { ...draftOf(terse), kind: 'reviewer' } } }

export const KindLockedInUse: Story = { name: 'In use, so the kind is locked', args: { ...base, inUse: true, agent: skilled, draft: draftOf(skilled) } }

export const NewAgentWithKind: Story = { name: 'New agent, a reviewer', args: { ...base, agent: undefined, creating: true, draft: { ...emptyDraft(), name: 'Strict reviewer', kind: 'reviewer' } } }

export const SkillsLoading: Story = { name: 'Skills are loading', args: { ...base, skills: { status: 'loading', skills: [] } } }

export const SkillsLoadError: Story = { name: 'Skills could not be loaded', args: { ...base, skills: { status: 'error', skills: [] } } }

export const NoSkillsYet: Story = { name: 'No skills exist yet', args: { ...base, skills: { status: 'ready', skills: [] } } }

export const SkillsAtTheCharacterLimit: Story = {
  name: 'Skills at the limit of 6,000 characters',
  args: { ...base, skills: { status: 'ready', skills: skillFixtures.big }, dirty: true, draft: { ...draftOf(terse), skillIds: ['skill-big-a', 'skill-big-b'] } },
}

export const SkillsError: Story = { name: 'A skill was deleted meanwhile', args: { ...base, dirty: true, draft: { ...draftOf(terse), skillIds: ['skill-slack'] }, error: 'skills.error.agentSkillsUnknown' } }
