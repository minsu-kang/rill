import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { pause, typeInto } from '../../story-utils/dom'
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
