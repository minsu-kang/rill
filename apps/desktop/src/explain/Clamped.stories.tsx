import type { Meta, StoryObj } from '@storybook/react-vite'
import { Clamped } from './Clamped'

const meta = {
  title: 'Explain/Clamped',
  component: Clamped,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 'var(--space-4)', color: 'var(--text-primary)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Clamped>

export default meta

type Story = StoryObj<typeof meta>

export const Short: Story = { args: { text: '짧은 글은 그대로 보여요.' } }

export const Long: Story = { args: { text: '긴 글은 앞부분만 보여요. '.repeat(80) } }

export const TooLongEvenOpen: Story = { args: { text: '매우 긴 글. '.repeat(1_000) } }
