import type { Meta, StoryObj } from '@storybook/react-vite'
import { SafeText } from './SafeText'

const meta = {
  title: 'UI/SafeText',
  component: SafeText,
  decorators: [
    (Story) => (
      <div style={{ padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SafeText>

export default meta

type Story = StoryObj<typeof meta>

export const Plain: Story = { args: { text: 'Cafe Mori receipt.pdf' } }

export const ReversedFileName: Story = { args: { text: 'invoice ‮txt.exe' } }

export const ZeroWidthSpaces: Story = { args: { text: 'pa​ss​word' } }

export const RightToLeftText: Story = { args: { text: 'שלום world (12)' } }
