import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { ExplainNotice, type ExplainNoticeProps } from './ExplainNotice'

function Stateful(props: ExplainNoticeProps) {
  const [skip, setSkip] = useState(props.skipNext)
  return <ExplainNotice {...props} skipNext={skip} onSkipNextChange={setSkip} />
}

const meta = {
  title: 'Explain/ExplainNotice',
  component: ExplainNotice,
  args: { model: { provider: 'anthropic', model: 'claude-sonnet-5' }, effort: 'medium', skipNext: false, onSkipNextChange: () => undefined, onSend: () => undefined, onCancel: () => undefined },
  render: (args) => <Stateful {...args} />,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExplainNotice>

export default meta

type Story = StoryObj<typeof meta>

export const ProviderNamed: Story = {}

export const ProviderUnknown: Story = { args: { model: undefined } }

export const ThoroughEffort: Story = { args: { effort: 'high' } }

export const DontAskAgainTicked: Story = { args: { skipNext: true } }

export const LongProviderAndModel: Story = { args: { model: { provider: 'a-very-long-provider-name'.repeat(4), model: 'a-very-long-model-name-with-many-parts'.repeat(3) } } }
