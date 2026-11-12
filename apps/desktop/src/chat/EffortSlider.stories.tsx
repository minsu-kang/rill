import type { LlmModelInfo, PlanEffort } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { models, modelsHaikuActive } from '../fixtures/plan'
import { EffortSlider } from './EffortSlider'
import type { EffortHint } from './model/effort'
import { activeModelOf } from './model/models'

const opus = activeModelOf(models)!
const haiku = activeModelOf(modelsHaikuActive)!

const HINTS: EffortHint[] = [
  { effort: 'low', costUsd: 0.012, latencyMs: 6_000, basis: 'planner evaluation, 48 cases' },
  { effort: 'medium', costUsd: 0.041, latencyMs: 14_000, basis: 'planner evaluation, 48 cases' },
  { effort: 'high', costUsd: 0.09, latencyMs: 31_000, basis: 'planner evaluation, 48 cases' },
  { effort: 'xhigh', costUsd: 0.21, latencyMs: 58_000, basis: 'pilot run, 6 cases' },
  { effort: 'max', costUsd: 0.42, latencyMs: 95_000, basis: 'pilot run, 6 cases' },
]

function Demo({ initial, model, hints, disabled }: { initial: PlanEffort; model: LlmModelInfo | undefined; hints?: EffortHint[]; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <div style={{ width: 420, padding: 'var(--space-4)' }}>
      <EffortSlider value={value} onChange={setValue} model={model} hints={hints} disabled={disabled} />
    </div>
  )
}

const meta = { title: 'Chat/EffortSlider', component: EffortSlider } satisfies Meta<typeof EffortSlider>

export default meta

type Story = StoryObj<typeof meta>

const base = { value: 'medium', onChange: () => undefined, model: opus } as const

export const Fast: Story = { args: base, render: () => <Demo initial="low" model={opus} /> }

export const Normal: Story = { args: base, render: () => <Demo initial="medium" model={opus} /> }

export const Careful: Story = { args: base, render: () => <Demo initial="high" model={opus} /> }

export const VeryCareful: Story = { name: 'Very careful', args: base, render: () => <Demo initial="xhigh" model={opus} /> }

export const MaximumAdvanced: Story = { name: 'Maximum (advanced)', args: base, render: () => <Demo initial="max" model={opus} /> }

export const ModelWithFewerLevels: Story = { name: 'Model with fewer levels', args: base, render: () => <Demo initial="medium" model={haiku} /> }

export const ChosenStepIsLowered: Story = { name: 'Chosen step is lowered', args: base, render: () => <Demo initial="xhigh" model={haiku} /> }

export const NoModel: Story = { name: 'No model', args: base, render: () => <Demo initial="medium" model={undefined} /> }

export const WithMeasuredHints: Story = { name: 'With measured hints', args: base, render: () => <Demo initial="medium" model={opus} hints={HINTS} /> }

export const WithoutHints: Story = { name: 'Without hints', args: base, render: () => <Demo initial="medium" model={opus} /> }

export const Disabled: Story = { args: base, render: () => <Demo initial="high" model={opus} disabled /> }
