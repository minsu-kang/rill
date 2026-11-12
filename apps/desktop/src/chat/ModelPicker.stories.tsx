import type { LlmModelsResult, ProviderId } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useT } from '../i18n'
import { models, modelsNothingConfigured } from '../fixtures/plan'
import { ModelPicker } from './ModelPicker'

function Demo({ data }: { data: LlmModelsResult }) {
  const t = useT()
  const [choice, setChoice] = useState<{ provider: ProviderId; model: string } | undefined>(undefined)
  return (
    <div style={{ width: 420, padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <ModelPicker models={data} onSelect={setChoice} />
      <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        {t('chat.model.label')}: {choice === undefined ? '-' : `${choice.provider}:${choice.model}`}
      </p>
    </div>
  )
}

const hostile: LlmModelsResult = {
  ...models,
  providers: models.providers.map((provider, index) => (index === 0 ? { ...provider, label: '<img src=x onerror=alert(1)> Anthropic' } : provider)),
  models: models.models.map((model, index) =>
    index === 0 ? { ...model, label: '<b>Claude</b> ‮gpj', capabilities: { ...model.capabilities, dataNote: '<a href="https://evil.example">Read the terms</a> and **trust us**.' } } : model,
  ),
}

const meta = { title: 'Chat/ModelPicker', component: ModelPicker, args: { models } } satisfies Meta<typeof ModelPicker>

export default meta

type Story = StoryObj<typeof meta>

export const FiveProviders: Story = { name: 'Five providers, one without a key', render: () => <Demo data={models} /> }

export const NothingConfigured: Story = { name: 'Nothing configured', render: () => <Demo data={modelsNothingConfigured} /> }

export const HostileEngineText: Story = { name: 'Hostile engine text', render: () => <Demo data={hostile} /> }

export const EmptyTable: Story = { name: 'Empty table', render: () => <Demo data={{ models: [], providers: [], active: null }} /> }
