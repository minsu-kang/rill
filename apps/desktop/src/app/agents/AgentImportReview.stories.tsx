import type { Meta, StoryObj } from '@storybook/react-vite'
import { agentFixtures } from '../../fixtures/agents'
import { AgentImportReview, type AgentImportReviewProps } from './AgentImportReview'
import { parseAgentFile } from './agent-file'
import { reviewOutcome } from './model/review'
import { builtinAgent } from '../../engine/fake-agents'
import type { ReviewState } from './model/view'

const meta = { title: 'App/Agents/AgentImportReview', component: AgentImportReview } satisfies Meta<typeof AgentImportReview>
export default meta
type Story = StoryObj<typeof meta>

const FILE = ['---', 'name: Imported helper', 'description: Made in another app', '---', '', '# Persona', '', 'Calm and brief.', '', '# Instructions', '', 'Name every default you pick.', 'Prefer one node less.', ''].join('\n')

function reviewOf(text: string, fileName = 'Imported helper.md'): ReviewState {
  const parsed = parseAgentFile(text)
  return {
    fileName,
    base: parsed.fields,
    fileProblems: parsed.problems.filter((problem) => problem.kind === 'file'),
    name: parsed.fields?.name ?? '',
    description: parsed.fields?.description ?? '',
  }
}

function args(review: ReviewState, rest: Partial<AgentImportReviewProps> = {}): AgentImportReviewProps {
  return {
    review,
    outcome: reviewOutcome(review, [builtinAgent(), ...agentFixtures.few]),
    busy: false,
    error: undefined,
    onEdit: () => undefined,
    onSave: () => undefined,
    onCancel: () => undefined,
    ...rest,
  }
}

export const Clean: Story = { name: 'A clean file', args: args(reviewOf(FILE)) }

export const WithProblems: Story = {
  name: 'With problems',
  args: args(reviewOf(FILE.replace('description: Made in another app', 'description: Made in another app\nskills: a, b').replace('Calm and brief.', 'Ca\tlm and brief.').replace('Imported helper', 'x'.repeat(61)))),
}

export const NameAlreadyExists: Story = { name: 'The name already exists', args: args(reviewOf(FILE.replace('Imported helper', 'terse REVIEWER'))) }

export const NotAnAgentFile: Story = { name: 'A file that is not an agent', args: args(reviewOf('# Persona\n\nhello\n', 'notes.md')) }

export const Saving: Story = { args: args(reviewOf(FILE), { busy: true }) }

export const SaveFailed: Story = { name: 'Save failed', args: args(reviewOf(FILE), { error: 'chat.error.AGENT_FULL' }) }

export const HostileText: Story = {
  name: 'Hostile text',
  args: args(reviewOf(FILE.replace('Calm and brief.', '<img src=x onerror=alert(1)> \u202e[x](https://evil.example)').replace('Imported helper', '<b>Imported</b>'), '<img src=x onerror=alert(2)>\u202e.md')),
}

export const EmptyPersonaAndInstructions: Story = {
  name: 'Empty persona and instructions',
  args: args(reviewOf('---\nname: Only a name\ndescription:\n---\n\n# Persona\n\n# Instructions\n')),
}

export const LongText: Story = {
  name: 'Long persona and instructions',
  args: args(reviewOf(FILE.replace('Calm and brief.', 'Calm and brief. '.repeat(35)).replace('Name every default you pick.', 'A very long line of instructions. '.repeat(80)))),
}

