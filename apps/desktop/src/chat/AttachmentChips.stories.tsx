import type { Meta, StoryObj } from '@storybook/react-vite'
import { allAttachmentRefs, attachmentRefs } from '../fixtures/plan'
import { AttachmentChips } from './AttachmentChips'

const meta = {
  title: 'Chat/AttachmentChips',
  component: AttachmentChips,
  args: { items: [], pending: [], errors: [], onRemove: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ width: 420, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AttachmentChips>

export default meta

type Story = StoryObj<typeof meta>

export const Normal: Story = { args: { items: [attachmentRefs.pdf, attachmentRefs.png, attachmentRefs.csv] } }

export const ManyChips: Story = { name: 'Many chips', args: { items: allAttachmentRefs } }

export const HostileNames: Story = { name: 'Hostile names', args: { items: [attachmentRefs.hostile, attachmentRefs.long] } }

export const AddingAndFailed: Story = {
  name: 'Adding and failed',
  args: {
    items: [attachmentRefs.pdf],
    pending: [{ name: 'scan-0042.jpeg' }],
    errors: [
      { name: 'huge-report.pdf', reason: 'The file is too large. The limits are 20 MiB for a PDF, 3.75 MiB for an image and 1 MiB for text.' },
      { name: 'setup.exe', reason: 'This file type is not supported.' },
      { name: 'invoice‮gpj.exe', reason: 'The attachment was rejected. Check its type and size.' },
    ],
  },
}
