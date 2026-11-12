import type { WorkflowNode } from '@rill/dsl'
import type { NodeInfo, StepDetail } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { catalog, fixtureSteps, ids, workflows } from '../fixtures'
import { statesFromSteps } from '../model/steps'
import { stateOf, type NodeRunState } from '../model/status'
import { Inspector } from './Inspector'

const info = (type: string): NodeInfo => catalog.find((entry) => entry.type === type)!
const nodeOf = (workflow: keyof typeof workflows, id: string): WorkflowNode => workflows[workflow].nodes.find((item) => item.id === id)!
const rowsOf = (runId: string): StepDetail[] => fixtureSteps[runId] ?? []
const stateFor = (runId: string, nodeId: string): NodeRunState | undefined => stateOf(statesFromSteps(rowsOf(runId)), nodeId)

const extract = nodeOf('receipt', 'extract')
const check = nodeOf('branching', 'check')

const meta = {
  title: 'Inspector/Inspector',
  component: Inspector,
  args: { node: extract, info: info('llm.extract@1'), steps: [], state: undefined, timeZone: 'Asia/Seoul' },
  decorators: [
    (Story) => (
      <div style={{ width: 400, height: 720, padding: 'var(--space-3)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Inspector>

export default meta

type Story = StoryObj<typeof meta>

export const NoSelection: Story = { args: { node: undefined, info: undefined } }

export const NotRunYet: Story = {}

export const TriggerNode: Story = { args: { node: nodeOf('receipt', 'watch'), info: info('trigger.folderWatch@1') } }

export const Succeeded: Story = {
  args: { steps: rowsOf(ids.runs.receiptOk), state: stateFor(ids.runs.receiptOk, 'extract') },
}

export const FailedAfterRetries: Story = {
  args: { steps: rowsOf(ids.runs.receiptFailed), state: stateFor(ids.runs.receiptFailed, 'extract') },
}

export const ContinuedAfterError: Story = {
  args: { node: check, info: info('http.request@1'), steps: rowsOf(ids.runs.branchingContinued), state: stateFor(ids.runs.branchingContinued, 'check') },
}

export const RunningWithoutRowsYet: Story = {
  args: { state: { status: 'running', attempt: 2, retrying: true, error: 'provider error: 503 Service Unavailable' } },
}

export const SkippedNode: Story = {
  args: { node: nodeOf('branching', 'alert'), info: info('notify.slack@1'), steps: rowsOf(ids.runs.branchingSkipped), state: stateFor(ids.runs.branchingSkipped, 'alert') },
}

export const HostileRunData: Story = {
  args: { steps: rowsOf(ids.runs.receiptHostile), state: stateFor(ids.runs.receiptHostile, 'extract') },
}
