import type { WorkflowSummary } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { ids } from '../../fixtures'
import { WorkflowHeader, type WorkflowHeaderProps } from './WorkflowHeader'

type ControlledProps = Omit<WorkflowHeaderProps, 'summary'>

function Controlled({ list, selectedId, onSelect }: ControlledProps) {
  const [chosen, setChosen] = useState(selectedId)
  return (
    <WorkflowHeader
      list={list}
      selectedId={chosen}
      summary={list.workflows.find((item) => item.id === chosen)}
      onSelect={(id) => {
        setChosen(id)
        onSelect(id)
      }}
    />
  )
}

const refresh = async (): Promise<void> => undefined
const receipt: WorkflowSummary = { id: ids.workflows.receipt, name: '영수증 정리', active: true, triggerType: 'trigger.folderWatch@1', createdAt: 3 }
const daily: WorkflowSummary = { id: ids.workflows.branching, name: '매일 서버 상태 확인', active: true, triggerType: 'trigger.cron@1', createdAt: 2 }
const hook: WorkflowSummary = { id: ids.workflows.webhook, name: '웹훅을 슬랙으로 전달', active: false, triggerType: 'trigger.webhook@1', createdAt: 1 }
const ready = (workflows: readonly WorkflowSummary[]): ControlledProps['list'] => ({ status: 'ready', workflows, refresh })

const meta: Meta<typeof Controlled> = {
  title: 'App/Workflows/WorkflowHeader',
  component: Controlled,
  args: { list: ready([receipt, daily, hook]), selectedId: receipt.id, onSelect: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
}
export default meta
type Story = StoryObj<typeof Controlled>

export const ManyWorkflows: Story = { name: 'Several workflows (chevron, active)' }
export const TwoWorkflows: Story = { args: { list: ready([receipt, daily]) } }
export const OneWorkflow: Story = { name: 'One workflow (no chevron)', args: { list: ready([receipt]) } }
export const KeyboardFocus: Story = {
  name: 'Keyboard focus on the title',
  play: async ({ canvasElement }) => {
    canvasElement.querySelector('select')?.focus()
  },
}
export const Inactive: Story = { name: 'Inactive webhook workflow', args: { selectedId: hook.id } }
export const ScheduleTrigger: Story = { args: { selectedId: daily.id } }
export const UnknownTriggerKind: Story = {
  args: { list: ready([{ ...receipt, triggerType: 'trigger.somethingNew@2' }, daily]) },
}
export const NewWorkflowNotListedYet: Story = { args: { selectedId: 'wf-just-deployed' } }
export const NothingSelected: Story = { args: { selectedId: undefined } }
export const Empty: Story = { args: { list: ready([]) } }
export const Loading: Story = { args: { list: { status: 'loading', workflows: [], refresh } } }
export const LoadError: Story = { args: { list: { status: 'error', workflows: [], refresh } } }
export const LongName: Story = {
  args: { list: ready([{ ...receipt, name: '매일 아침 받은 편지함의 영수증을 모아서 월별 장부에 정리하고 팀 채널에 요약을 보내는 아주 긴 이름의 워크플로우 '.repeat(3) }, daily]) },
}
export const HostileName: Story = {
  args: {
    list: ready([{ ...receipt, name: '<img src=x onerror=alert(1)> 이름 \u202Etxt.exe \u200B\u2066zero\u2069', triggerType: 'trigger.<b>x</b>@1' }, daily]),
  },
}
export const NarrowWithLongName: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 340 }}>
        <Story />
      </div>
    ),
  ],
  args: { list: ready([{ ...receipt, name: '매일 아침 받은 편지함의 영수증을 모아서 월별 장부에 정리하는 워크플로우' }, daily]) },
}
