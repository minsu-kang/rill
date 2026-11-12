import type { Meta, StoryObj } from '@storybook/react-vite'
import { ExternalTransferNotice } from './ExternalTransferNotice'

const meta = {
  title: 'Chat/ExternalTransferNotice',
  component: ExternalTransferNotice,
  decorators: [
    (Story) => (
      <div style={{ width: 420, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExternalTransferNotice>

export default meta

type Story = StoryObj<typeof meta>

export const RequestOnly: Story = { name: 'Request only', args: { items: ['request'] } }

export const AttachmentsAndNotes: Story = { name: 'Attachments and notes', args: { items: ['request', 'attachments', 'memory'] } }
