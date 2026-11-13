import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { skillFixtures } from '../../fixtures/skills'
import { emptySkillDraft, skillDraftOf } from './model/skill-draft'
import { SkillEditor, type SkillEditorProps } from './SkillEditor'

const meta = { title: 'App/Agents/SkillEditor', component: SkillEditor } satisfies Meta<typeof SkillEditor>
export default meta
type Story = StoryObj<typeof meta>

const receipts = skillFixtures.few[0]!

const base: SkillEditorProps = {
  skill: receipts,
  creating: false,
  draft: skillDraftOf(receipts),
  dirty: false,
  busy: false,
  error: undefined,
  status: undefined,
  users: agentFixtures.skilled,
  onChange: () => undefined,
  onSave: () => undefined,
  onRevert: () => undefined,
  onDelete: () => undefined,
}

export const SavedSkill: Story = { name: 'Saved skill, used by an agent', args: base }

export const SkillNobodyUses: Story = { name: 'Saved skill, no agent uses it', args: { ...base, users: [] } }

export const Saved: Story = { args: { ...base, status: 'skills.status.saved' } }

export const NewSkillEmpty: Story = { name: 'New skill, empty', args: { ...base, skill: undefined, creating: true, draft: emptySkillDraft(), users: [] } }

export const WithProblems: Story = { name: 'With problems', args: { ...base, dirty: true, draft: { name: '', description: 'two\nlines', body: 'tab\there' } } }

export const BodyTooLong: Story = { name: 'The text is too long', args: { ...base, dirty: true, draft: { ...skillDraftOf(receipts), body: 'x'.repeat(4050) } } }

export const Edited: Story = { name: 'Edited, not saved', args: { ...base, dirty: true, draft: { ...skillDraftOf(receipts), name: 'Receipts checklist, v2' } } }

export const Saving: Story = { args: { ...base, busy: true, dirty: true, draft: { ...skillDraftOf(receipts), name: 'Receipts checklist, v2' } } }

export const SaveError: Story = { name: 'Save error', args: { ...base, dirty: true, error: 'skills.error.SKILL_DUPLICATE' } }

export const TooLargeForAnAgent: Story = { name: 'Too large for an agent', args: { ...base, dirty: true, error: 'skills.error.tooLargeForAgent' } }

export const HostileName: Story = {
  name: 'Hostile name',
  args: { ...base, skill: skillFixtures.hostile[0]!, draft: skillDraftOf(skillFixtures.hostile[0]!), users: [{ ...agentFixtures.hostile[0]!, skillIds: ['skill-hostile'] }] },
}
