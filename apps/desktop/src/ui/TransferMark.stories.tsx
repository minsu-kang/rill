import type { Meta, StoryObj } from '@storybook/react-vite'
import { TransferMark } from './TransferMark'

const meta: Meta<typeof TransferMark> = {
  title: 'UI/TransferMark',
  component: TransferMark,
  args: { label: 'External transfer', hint: 'The content of this step is sent to the AI provider.' },
}
export default meta
type Story = StoryObj<typeof TransferMark>

export const Default: Story = {}
export const Large: Story = { args: { size: 24 } }
