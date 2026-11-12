import type { Meta, StoryObj } from '@storybook/react-vite'
import { ActionButtons } from './ActionButtons'

const meta = {
  title: 'Explain/ActionButtons',
  component: ActionButtons,
  args: { runId: 'run-receipt-failed', nodeId: 'extract', onAction: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 'var(--space-4)', color: 'var(--text-primary)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActionButtons>

export default meta

type Story = StoryObj<typeof meta>

export const OneAction: Story = { args: { actions: ['edit_node'] } }

export const TwoActions: Story = { args: { actions: ['check_input_file', 'retry_run'] } }

export const ThreeActions: Story = { args: { actions: ['open_connections', 'retry_run', 'deactivate_workflow'] } }

export const WaitAndRetryReminder: Story = { args: { actions: ['wait_and_retry', 'retry_run'] } }

export const ConfirmRetry: Story = {
  args: { actions: ['open_connections', 'retry_run', 'deactivate_workflow'] },
  play: async ({ canvas, userEvent }) => {
    const buttons = await canvas.findAllByRole('button')
    await userEvent.click(buttons[1]!)
  },
}

export const ConfirmDeactivate: Story = {
  args: { actions: ['open_connections', 'retry_run', 'deactivate_workflow'] },
  play: async ({ canvas, userEvent }) => {
    const buttons = await canvas.findAllByRole('button')
    await userEvent.click(buttons[2]!)
  },
}
