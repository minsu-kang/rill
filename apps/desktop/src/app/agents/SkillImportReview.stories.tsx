import type { Meta, StoryObj } from '@storybook/react-vite'
import { skillFixtures } from '../../fixtures/skills'
import { skillReviewOutcome } from './model/skill-review'
import type { SkillReviewState } from './model/skill-view'
import { parseSkillFile } from './skill-file'
import { SkillImportReview, type SkillImportReviewProps } from './SkillImportReview'

const meta = { title: 'App/Agents/SkillImportReview', component: SkillImportReview } satisfies Meta<typeof SkillImportReview>
export default meta
type Story = StoryObj<typeof meta>

const FILE = ['---', 'name: Imported checklist', 'description: Made in another app', '---', '', '# Body', '', 'Check the vendor.', 'Check the total.', ''].join('\n')

function reviewOf(text: string, fileName = 'Imported checklist.md'): SkillReviewState {
  const parsed = parseSkillFile(text)
  return {
    fileName,
    base: parsed.fields,
    fileProblems: parsed.problems.filter((problem) => problem.kind === 'file'),
    name: parsed.fields?.name ?? '',
    description: parsed.fields?.description ?? '',
  }
}

function args(review: SkillReviewState, rest: Partial<SkillImportReviewProps> = {}): SkillImportReviewProps {
  return {
    review,
    outcome: skillReviewOutcome(review, skillFixtures.few),
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
  args: args(reviewOf(FILE.replace('description: Made in another app', 'description: Made in another app\nkind: reviewer').replace('Check the vendor.', 'Che\tck the vendor.').replace('Imported checklist', 'x'.repeat(61)))),
}

export const NameAlreadyExists: Story = { name: 'The name already exists', args: args(reviewOf(FILE.replace('Imported checklist', 'receipts CHECKLIST'))) }

export const NotASkillFile: Story = { name: 'A file that is not a skill', args: args(reviewOf('# Body\n\nhello\n', 'notes.md')) }

export const Saving: Story = { args: args(reviewOf(FILE), { busy: true }) }

export const SaveFailed: Story = { name: 'Save failed', args: args(reviewOf(FILE), { error: 'skills.error.SKILL_FULL' }) }

export const HostileText: Story = {
  name: 'Hostile text',
  args: args(reviewOf(FILE.replace('Check the vendor.', '<img src=x onerror=alert(1)> \u202e[x](https://evil.example)').replace('Imported checklist', '<b>Imported</b>'), '<img src=x onerror=alert(2)>\u202e.md')),
}

export const LongText: Story = { name: 'A long text', args: args(reviewOf(FILE.replace('Check the vendor.', 'A very long line of the skill. '.repeat(120)))) }
