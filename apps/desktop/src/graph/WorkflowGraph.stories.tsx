import type { Workflow } from '@rill/dsl'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { catalog, fixtureSteps, ids, largeStates, largeWorkflow, workflows } from '../fixtures'
import { useLocale } from '../i18n'
import { NO_STATES, type RunStates } from '../model/status'
import { statesFromSteps } from '../model/steps'
import { Sized } from '../story-utils/Frame'
import { ThemeProvider } from '../theme/ThemeProvider'
import { WorkflowGraph } from './WorkflowGraph'

const statesOf = (runId: string): RunStates => statesFromSteps(fixtureSteps[runId] ?? [])
const large = largeWorkflow()

function Selectable({ workflow, states }: { workflow: Workflow; states: RunStates }) {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  return <WorkflowGraph workflow={workflow} catalog={catalog} states={states} selectedNodeId={selected} onSelect={setSelected} />
}

function LightAndDark() {
  const locale = useLocale()
  const states = statesOf(ids.runs.branchingContinued)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {(['light', 'dark'] as const).map((theme) => (
        <div key={theme} style={{ height: 480, overflow: 'hidden', borderRadius: 'var(--radius-md)' }}>
          <ThemeProvider theme={theme} locale={locale}>
            <div style={{ height: 480, padding: 'var(--space-3)', background: 'var(--surface-base)' }}>
              <WorkflowGraph workflow={workflows.branching} catalog={catalog} states={states} selectedNodeId="check" />
            </div>
          </ThemeProvider>
        </div>
      ))}
    </div>
  )
}

const meta = {
  title: 'Graph/WorkflowGraph',
  component: WorkflowGraph,
  args: { workflow: workflows.branching, catalog, states: NO_STATES },
  decorators: [
    (Story, context) => (
      <Sized height={typeof context.parameters.graphHeight === 'number' ? context.parameters.graphHeight : 560}>
        <Story />
      </Sized>
    ),
  ],
} satisfies Meta<typeof WorkflowGraph>

export default meta

type Story = StoryObj<typeof meta>

export const NoRunOpen: Story = {}
export const ReceiptSucceeded: Story = { args: { workflow: workflows.receipt, states: statesOf(ids.runs.receiptOk) } }
export const ReceiptFailedAfterRetries: Story = { args: { workflow: workflows.receipt, states: statesOf(ids.runs.receiptFailed) } }
export const BranchingRunning: Story = { args: { states: statesOf(ids.runs.branchingRunning) } }
export const BranchingSkippedBranch: Story = { args: { states: statesOf(ids.runs.branchingSkipped) } }
export const BranchingContinuedAfterError: Story = { args: { states: statesOf(ids.runs.branchingContinued) } }
export const WebhookAbandoned: Story = { args: { workflow: workflows.webhook, states: statesOf(ids.runs.webhookAbandoned) } }
export const WebhookDryRun: Story = { args: { workflow: workflows.webhook, states: statesOf(ids.runs.webhookDry) } }
export const ClickToSelect: Story = { render: (args) => <Selectable workflow={args.workflow} states={statesOf(ids.runs.branchingSkipped)} /> }
export const ThirtyNodes: Story = { args: { workflow: large, states: largeStates(large) }, parameters: { graphHeight: 680 } }
export const LightAndDarkSideBySide: Story = { name: 'Light and dark side by side', parameters: { graphHeight: 1040 }, render: () => <LightAndDark /> }
