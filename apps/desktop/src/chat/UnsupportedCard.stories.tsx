import type { Meta, StoryObj } from '@storybook/react-vite'
import { results } from '../fixtures/plan'
import { UnsupportedCard } from './UnsupportedCard'

const unsupported = results.unsupported as Extract<typeof results.unsupported, { kind: 'unsupported' }>

const meta = {
  title: 'Chat/UnsupportedCard',
  component: UnsupportedCard,
  args: { summary: unsupported.summary, reason: unsupported.reason, nearest: unsupported.nearest },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UnsupportedCard>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const HostileText: Story = {
  name: 'Hostile text',
  args: {
    summary: '<img src=x onerror=alert(1)> Done!',
    reason: `<a href="https://evil.example/pay">Open the settings</a> ${'because '.repeat(120)}`,
    nearest: '**Click here** ‮txt.exe and a​hidden\u0007bell',
  },
}
