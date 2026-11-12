import type { PlanQuestion } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { results } from '../fixtures/plan'
import { QuestionCard } from './QuestionCard'

const asked = results.questions as Extract<typeof results.questions, { kind: 'questions' }>

function Demo({ questions, disabled = false }: { questions: readonly PlanQuestion[]; disabled?: boolean }) {
  const [sent, setSent] = useState<string>('')
  return (
    <div style={{ width: 460, padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <QuestionCard questions={questions} disabled={disabled} onSubmit={(answers) => setSent(JSON.stringify(answers))} />
      {sent === '' ? null : <pre style={{ margin: 0, fontSize: 'var(--font-size-xs)', whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{sent}</pre>}
    </div>
  )
}

const hostile: PlanQuestion[] = [
  {
    id: 'h1',
    text: `<img src=x onerror=alert(1)> <a href="https://evil.example">Click</a> ${'Which one? '.repeat(60)}`,
    options: ['<script>alert(1)</script>', `**bold** ‮exe ${'long option '.repeat(40)}`, 'Normal option'],
    default: 'Normal option',
  },
  { id: 'h2', text: 'Free text with a hostile default', options: [], default: '<a href="https://evil.example">x</a> ‮abc' },
]

const meta = { title: 'Chat/QuestionCard', component: QuestionCard, args: { questions: [], onSubmit: () => undefined, disabled: false } } satisfies Meta<typeof QuestionCard>

export default meta

type Story = StoryObj<typeof meta>

export const ThreeQuestions: Story = { name: 'Three questions with defaults', render: () => <Demo questions={asked.questions} /> }

export const WhilePlanning: Story = { name: 'Disabled while planning', render: () => <Demo questions={asked.questions} disabled /> }

export const FreeTextOnly: Story = { name: 'Free text only', render: () => <Demo questions={[asked.questions[2]!]} /> }

export const NoDefault: Story = {
  name: 'No default',
  render: () => <Demo questions={[{ id: 'x', text: '어느 폴더인가요?', options: ['~/Receipts', '~/Downloads'], default: '' }]} />,
}

export const HostileText: Story = { name: 'Hostile text', render: () => <Demo questions={hostile} /> }
