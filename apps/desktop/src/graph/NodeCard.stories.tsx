import type { WorkflowNode } from '@rill/dsl'
import type { NodeInfo } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { catalog } from '../fixtures'
import { useT } from '../i18n'
import { NODE_STATUSES, type NodeRunState, type NodeStatus } from '../model/status'
import { TreeFrame } from '../story-utils/Frame'
import { NodeCard } from './NodeCard'

const info = (type: string): NodeInfo => catalog.find((entry) => entry.type === type)!
const extract: WorkflowNode = { id: 'extract', type: 'llm.extract@1', config: {} }
const append: WorkflowNode = { id: 'append', type: 'csv.append@1', config: {} }
const request: WorkflowNode = { id: 'check', type: 'http.request@1', config: {} }
const shape: WorkflowNode = { id: 'shape', type: 'transform@1', config: {} }

const state = (status: NodeStatus, extra: Partial<NodeRunState> = {}): NodeRunState => ({ status, attempt: 1, retrying: false, error: null, ...extra })

function AllStatuses() {
  const t = useT()
  return (
    <TreeFrame label={t('graph.label')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 270px)', gap: 'var(--space-4)' }}>
      {NODE_STATUSES.map((status) => (
        <NodeCard key={status} node={{ ...shape, id: status }} info={info('transform@1')} state={state(status)} selected={false} />
      ))}
    </TreeFrame>
  )
}

const meta = {
  title: 'Graph/NodeCard',
  component: NodeCard,
  args: { node: shape, info: info('transform@1'), state: undefined, selected: false },
  decorators: [
    (Story) => (
      <TreeFrame label="node">
        <Story />
      </TreeFrame>
    ),
  ],
} satisfies Meta<typeof NodeCard>

export default meta

type Story = StoryObj<typeof meta>

export const Idle: Story = { args: { state: state('idle') } }
export const Running: Story = { args: { state: state('running') } }
export const Succeeded: Story = { args: { state: state('succeeded') } }
export const Failed: Story = { args: { state: state('failed', { error: 'provider error: 503 Service Unavailable' }) } }
export const Abandoned: Story = { args: { state: state('abandoned') } }
export const Skipped: Story = { args: { state: state('skipped') } }
export const Continued: Story = { args: { state: state('continued', { attempt: 2, error: 'request timed out after 15000 ms' }) } }
export const Selected: Story = { args: { state: state('succeeded'), selected: true } }
export const Retrying: Story = { args: { node: extract, info: info('llm.extract@1'), state: state('running', { attempt: 3, retrying: true, error: 'HTTP 503' }) } }
export const ExternalTransfer: Story = { args: { node: extract, info: info('llm.extract@1'), state: state('succeeded') } }
export const WritesFile: Story = { args: { node: append, info: info('csv.append@1'), state: state('succeeded') } }
export const NetworkCall: Story = { args: { node: request, info: info('http.request@1'), state: state('running') } }
export const LongText: Story = {
  args: {
    node: { id: `very_long_node_identifier_${'x'.repeat(40)}`, type: 'transform@1', config: {} },
    info: { ...info('transform@1'), title: 'A node title that is much longer than the card can show on one line' },
    state: state('failed', { attempt: 3 }),
  },
}
export const MissingCatalogEntry: Story = { args: { node: { id: 'mystery', type: 'vendor.custom_step@2', config: {} }, info: undefined, state: state('idle') } }
export const AllStatusesTogether: Story = { name: 'All statuses', render: () => <AllStatuses /> }
