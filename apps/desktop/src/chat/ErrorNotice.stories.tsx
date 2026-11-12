import type { Meta, StoryObj } from '@storybook/react-vite'
import type { MessageKey } from '../i18n'
import { ErrorNotice } from './ErrorNotice'

const KEYS: MessageKey[] = [
  'chat.error.LLM_UNAVAILABLE',
  'chat.error.PLAN_INVALID',
  'chat.error.PLAN_PROVIDER',
  'chat.error.PLAN_CANCELLED',
  'chat.error.PLAN_BUSY',
  'chat.error.PLAN_EXISTS',
  'chat.error.PLAN_NOT_CONFIRMED',
  'chat.error.PLAN_DEPLOYED',
  'chat.error.ATTACHMENT_REJECTED',
  'chat.error.MEMORY_INVALID',
  'chat.error.MEMORY_FULL',
  'chat.error.MEMORY_DUPLICATE',
  'chat.error.INVALID_PARAMS',
  'chat.error.INVALID_WORKFLOW',
  'chat.error.NOT_FOUND',
  'chat.error.INTERNAL',
  'chat.error.BAD_RESPONSE',
  'chat.error.generic',
  'chat.error.turnLimit',
]

function AllErrors() {
  return (
    <div style={{ width: 460, padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {KEYS.map((key) => (
        <ErrorNotice key={key} messageKey={key} />
      ))}
    </div>
  )
}

const meta = {
  title: 'Chat/ErrorNotice',
  component: ErrorNotice,
  args: { messageKey: 'chat.error.PLAN_PROVIDER' },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ErrorNotice>

export default meta

type Story = StoryObj<typeof meta>

export const Single: Story = {}

export const Dismissible: Story = { args: { onDismiss: () => undefined } }

export const EveryErrorCode: Story = { name: 'Every error code', render: () => <AllErrors /> }
