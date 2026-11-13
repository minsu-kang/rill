import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { filler, skillFixtures } from '../../fixtures/skills'
import { pause, typeInto } from '../../story-utils/dom'
import { SkillsStage, type SkillsStageProps } from './SkillsStage'

const meta: Meta<typeof SkillsStage> = { title: 'App/Agents/SkillsScreen', component: SkillsStage }
export default meta
type Story = StoryObj<typeof SkillsStage>

const used: SkillsStageProps = { skills: skillFixtures.few, agents: [...agentFixtures.skilled, ...agentFixtures.reviewers] }

function pressByText(canvasElement: HTMLElement, selector: string, text: RegExp): void {
  const match = [...canvasElement.querySelectorAll<HTMLElement>(selector)].find((node) => text.test(node.textContent ?? ''))
  match?.click()
}

const IMPORTED = ['---', 'name: Imported checklist', 'description: Made in another app', '---', '', '# Body', '', 'Check the vendor.', 'Check the total.', ''].join('\n')

function pressImport(canvasElement: HTMLElement): void {
  canvasElement.querySelector<HTMLElement>('[data-rill-import-skill]')?.click()
}

export const NoSkillsYet: Story = { name: 'No skills yet', args: {} }

export const FewSkills: Story = { name: 'A few skills, used by agents', args: used }

export const SkillNotUsedSelected: Story = {
  name: 'A skill that no agent uses is selected',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /한국어 요약 규칙/)
  },
}

export const EditorWithErrors: Story = {
  name: 'Editor with errors',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    typeInto(canvasElement.querySelector<HTMLInputElement>('input[type="text"]'), '')
    typeInto(canvasElement.querySelector<HTMLTextAreaElement>('textarea'), 'x'.repeat(4050))
  },
}

export const NewSkill: Story = {
  name: 'New skill',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    canvasElement.querySelector<HTMLElement>('[data-rill-new-skill]')?.click()
  },
}

export const AtTheLimit: Story = { name: 'At the limit of 24 skills', args: { skills: skillFixtures.full, agents: agentFixtures.skilled } }

export const HostileNames: Story = { name: 'Hostile names', args: { skills: [...skillFixtures.hostile, ...skillFixtures.long], agents: [{ ...agentFixtures.hostile[0]!, skillIds: ['skill-hostile'] }] } }

export const LongBody: Story = { name: 'A long text', args: { skills: skillFixtures.big, agents: [{ ...agentFixtures.few[0]!, skillIds: ['skill-big-a', 'skill-big-b'] }] } }

export const DeleteConfirmation: Story = {
  name: 'Delete confirmation, naming the agents',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'section button', /^Delete$|^삭제$/)
  },
}

export const DeleteConfirmationNoAgent: Story = {
  name: 'Delete confirmation, no agent has the skill',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /한국어 요약 규칙/)
    await pause(40)
    pressByText(canvasElement, 'section button', /^Delete$|^삭제$/)
  },
}

export const UnsavedChangesPrompt: Story = {
  name: 'Unsaved changes prompt',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    typeInto(canvasElement.querySelector<HTMLInputElement>('input[type="text"]'), 'Renamed skill')
    await pause(40)
    pressByText(canvasElement, 'ul button', /Slack message style/)
  },
}

export const Loading: Story = { args: { list: 'hang' } }

export const LoadError: Story = { name: 'Load error', args: { list: 'fail' } }

export const SaveFailsDuplicate: Story = {
  name: 'Saving fails: the name exists',
  args: { ...used, failSave: 'SKILL_DUPLICATE' },
  play: async ({ canvasElement }) => {
    await pause(80)
    typeInto(canvasElement.querySelector<HTMLInputElement>('input[type="text"]'), 'Slack message style')
    await pause(40)
    pressByText(canvasElement, 'button[type="submit"]', /.*/)
  },
}

export const SaveFailsTooLarge: Story = {
  name: 'Saving fails: an agent would pass 6,000 characters',
  args: { skills: skillFixtures.big, agents: [{ ...agentFixtures.few[0]!, skillIds: ['skill-big-a', 'skill-big-b'] }], failSave: 'SKILL_INVALID' },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Glossary/)
    await pause(40)
    typeInto(canvasElement.querySelector<HTMLTextAreaElement>('textarea'), filler(2600, 'Term and its meaning. '))
    await pause(40)
    pressByText(canvasElement, 'button[type="submit"]', /.*/)
  },
}

export const ImportReview: Story = {
  name: 'Import review',
  args: { ...used, textPicks: [{ name: 'Imported checklist.md', text: IMPORTED }] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const ImportReviewWithProblems: Story = {
  name: 'Import review with problems',
  args: {
    ...used,
    textPicks: [{ name: 'Imported checklist.md', text: IMPORTED.replace('description: Made in another app', 'description: Made in another app\nkind: reviewer').replace('Check the vendor.', 'Che\tck the vendor.').replace('Imported checklist', 'Slack message style') }],
  },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const ImportUnreadableFile: Story = {
  name: 'Import of a file that is not a skill',
  args: { ...used, textPicks: [{ name: 'notes.md', text: '# Body\n\nhello\n' }] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const ImportHostileFile: Story = {
  name: 'Import of a file with hostile text',
  args: { ...used, textPicks: [{ name: '<img src=x onerror=alert(1)>.md', text: IMPORTED.replace('Check the vendor.', '<img src=x onerror=alert(2)> \u202e[x](https://evil.example)').replace('Imported checklist', '<b>Imported</b>') }] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const Export: Story = {
  name: 'Export',
  args: used,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'button', /^Export…$|^내보내기…$/)
  },
}
