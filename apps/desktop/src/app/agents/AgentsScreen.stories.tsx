import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { skillFixtures } from '../../fixtures/skills'
import { chooseOption, pause, typeInto } from '../../story-utils/dom'
import { AgentsStage, type AgentsStageProps } from './AgentsStage'

const meta: Meta<typeof AgentsStage> = { title: 'App/Agents/AgentsScreen', component: AgentsStage }
export default meta
type Story = StoryObj<typeof AgentsStage>

const few: AgentsStageProps = { agents: agentFixtures.few, activeAgentId: 'agent-terse' }

function pressByText(canvasElement: HTMLElement, selector: string, text: RegExp): void {
  const match = [...canvasElement.querySelectorAll<HTMLElement>(selector)].find((node) => text.test(node.textContent ?? ''))
  match?.click()
}

export const OnlyDefault: Story = { name: 'Only the Default agent', args: {} }

export const FewAgents: Story = { name: 'A few agents', args: few }

export const AgentInUseSelected: Story = {
  name: 'An agent that is not in use is selected',
  args: { ...few },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Plain tone only/)
  },
}

export const EditorWithErrors: Story = {
  name: 'Editor with errors',
  args: few,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Terse reviewer/)
    await pause(40)
    typeInto(canvasElement.querySelector<HTMLInputElement>('input[type="text"]'), '')
    const areas = canvasElement.querySelectorAll<HTMLTextAreaElement>('textarea')
    typeInto(areas[1] ?? null, 'x'.repeat(3050))
  },
}

export const NewAgent: Story = {
  name: 'New agent',
  args: few,
  play: async ({ canvasElement }) => {
    await pause(80)
    canvasElement.querySelector<HTMLElement>('[data-rill-new-agent]')?.click()
  },
}

export const AtTheLimit: Story = { name: 'At the limit of 12 agents', args: { agents: agentFixtures.twelve, activeAgentId: 'agent-03' } }

export const HostileNames: Story = { name: 'Hostile names', args: { agents: [...agentFixtures.hostile, ...agentFixtures.long], activeAgentId: 'agent-hostile' } }

export const DeleteConfirmation: Story = {
  name: 'Delete confirmation',
  args: few,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'section button', /^Delete$|^삭제$/)
  },
}

export const UnsavedChangesPrompt: Story = {
  name: 'Unsaved changes prompt',
  args: few,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Terse reviewer/)
    await pause(40)
    typeInto(canvasElement.querySelector<HTMLInputElement>('input[type="text"]'), 'Renamed agent')
    await pause(40)
    pressByText(canvasElement, 'ul button', /Plain tone only/)
  },
}

export const Loading: Story = { args: { list: 'hang' } }

export const LoadError: Story = { name: 'Load error', args: { list: 'fail' } }

export const SaveFails: Story = {
  name: 'Saving fails',
  args: { ...few, failSave: 'AGENT_DUPLICATE' },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Terse reviewer/)
    await pause(40)
    typeInto(canvasElement.querySelector<HTMLInputElement>('input[type="text"]'), 'Plain tone only')
    await pause(40)
    pressByText(canvasElement, 'button[type="submit"]', /.*/)
  },
}

const IMPORTED = ['---', 'name: Imported helper', 'description: Made in another app', '---', '', '# Persona', '', 'Calm and brief.', '', '# Instructions', '', 'Name every default you pick.', 'Prefer one node less.', ''].join('\n')

function pressImport(canvasElement: HTMLElement): void {
  canvasElement.querySelector<HTMLElement>('[data-rill-import-agent]')?.click()
}

export const ImportReview: Story = {
  name: 'Import review',
  args: { ...few, textPicks: [{ name: 'Imported helper.md', text: IMPORTED }] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const ImportReviewWithProblems: Story = {
  name: 'Import review with problems',
  args: {
    ...few,
    textPicks: [{ name: 'Imported helper.md', text: IMPORTED.replace('description: Made in another app', 'description: Made in another app\nskills: a, b').replace('Calm and brief.', 'Ca\tlm and brief.').replace('Imported helper', 'Plain tone only') }],
  },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const ImportUnreadableFile: Story = {
  name: 'Import of a file that is not an agent',
  args: { ...few, textPicks: [{ name: 'notes.md', text: '# Persona\n\nhello\n' }] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const ImportHostileFile: Story = {
  name: 'Import of a file with hostile text',
  args: { ...few, textPicks: [{ name: '<img src=x onerror=alert(1)>.md', text: IMPORTED.replace('Calm and brief.', '<img src=x onerror=alert(2)> \u202e[x](https://evil.example)').replace('Imported helper', '<b>Imported</b>') }] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const Export: Story = {
  name: 'Export (the agent in use is selected)',
  args: few,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'button', /^Export…$|^내보내기…$/)
  },
}

const withSkills: AgentsStageProps = { height: 1500, agents: [...agentFixtures.few, ...agentFixtures.skilled, ...agentFixtures.reviewers], skills: skillFixtures.few, activeAgentId: 'agent-terse' }

export const KindAndSkillsInTheList: Story = { name: 'Kind chips and skill counts in the list', args: withSkills }

export const AgentWithSkillsSelected: Story = {
  name: 'An agent with skills is selected',
  args: withSkills,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Receipts helper/)
  },
}

export const ReviewerSelected: Story = {
  name: 'A reviewer is selected',
  args: withSkills,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Safety reviewer/)
  },
}

export const KindChangedToReviewer: Story = {
  name: 'The kind is changed to reviewer, not saved',
  args: withSkills,
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Plain tone only/)
    await pause(40)
    chooseOption(canvasElement.querySelector<HTMLSelectElement>('select'), 'reviewer')
  },
}

export const SkillsOnTheBudget: Story = {
  name: 'Skills close to the limit of 6,000 characters',
  args: { height: 1500, agents: [{ ...agentFixtures.few[0]!, skillIds: ['skill-big-a', 'skill-big-b'] }], skills: skillFixtures.big, activeAgentId: 'default' },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Terse reviewer/)
  },
}

export const NoSkillsToPick: Story = {
  name: 'No skills exist yet',
  args: { ...few, height: 1500, skills: [] },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressByText(canvasElement, 'ul button', /Plain tone only/)
  },
}

export const ReviewerFileImport: Story = {
  name: 'Import review of a reviewer file',
  args: {
    ...withSkills,
    textPicks: [{ name: 'Strict reviewer.md', text: ['---', 'name: Strict reviewer', 'description: Made in another app', 'kind: reviewer', '---', '', '# Persona', '', 'Strict and calm.', '', '# Instructions', '', 'Say what could go wrong.', ''].join('\n') }],
  },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}

export const InvalidKindImport: Story = {
  name: 'Import review with an invalid kind',
  args: {
    ...withSkills,
    textPicks: [{ name: 'Strict reviewer.md', text: ['---', 'name: Strict reviewer', 'description: Made in another app', 'kind: admin', '---', '', '# Persona', '', 'Strict and calm.', '', '# Instructions', '', 'Say what could go wrong.', ''].join('\n') }],
  },
  play: async ({ canvasElement }) => {
    await pause(80)
    pressImport(canvasElement)
  },
}
