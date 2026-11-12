import type { Meta, StoryObj } from '@storybook/react-vite'
import { ids } from '../../fixtures'
import { WorkflowSwitcher } from './WorkflowSwitcher'

const refresh = async (): Promise<void> => undefined
const workflows = [
  { id: ids.workflows.receipt, name: '영수증 정리', active: true, triggerType: 'trigger.folderWatch@1', createdAt: 3 },
  { id: ids.workflows.branching, name: '매일 서버 상태 확인', active: true, triggerType: 'trigger.cron@1', createdAt: 2 },
  { id: ids.workflows.webhook, name: '웹훅을 슬랙으로 전달', active: false, triggerType: 'trigger.webhook@1', createdAt: 1 },
]

const meta: Meta<typeof WorkflowSwitcher> = {
  title: 'App/Workflows/WorkflowSwitcher',
  component: WorkflowSwitcher,
  args: { list: { status: 'ready', workflows, refresh }, selectedId: ids.workflows.receipt, onSelect: () => undefined },
}
export default meta
type Story = StoryObj<typeof WorkflowSwitcher>

export const Selected: Story = {}
export const NothingSelected: Story = { args: { selectedId: undefined } }
export const NewWorkflowNotListedYet: Story = { args: { selectedId: 'wf-just-deployed' } }
export const Empty: Story = { args: { list: { status: 'ready', workflows: [], refresh } } }
export const Loading: Story = { args: { list: { status: 'loading', workflows: [], refresh } } }
export const LoadError: Story = { args: { list: { status: 'error', workflows: [], refresh } } }
export const HostileNames: Story = {
  args: {
    list: {
      status: 'ready',
      refresh,
      workflows: [
        { id: 'wf-h1', name: '<img src=x onerror=alert(1)> 이름 ‮txt.exe', active: true, triggerType: 'trigger.webhook@1', createdAt: 2 },
        { id: 'wf-h2', name: '긴 이름 '.repeat(30), active: false, triggerType: 'trigger.<b>x</b>@1', createdAt: 1 },
      ],
    },
    selectedId: 'wf-h1',
  },
}
