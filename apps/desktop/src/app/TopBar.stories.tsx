import type { Meta, StoryObj } from '@storybook/react-vite'
import { ids } from '../fixtures'
import { TopBar } from './TopBar'

const refresh = async (): Promise<void> => undefined
const workflows = [
  { id: ids.workflows.receipt, name: '영수증 정리', active: true, triggerType: 'trigger.folderWatch@1', createdAt: 3 },
  { id: ids.workflows.webhook, name: '웹훅을 슬랙으로 전달', active: false, triggerType: 'trigger.webhook@1', createdAt: 1 },
]

const meta: Meta<typeof TopBar> = {
  title: 'App/TopBar',
  component: TopBar,
  args: {
    tab: 'workflows',
    onTab: () => undefined,
    list: { status: 'ready', workflows, refresh },
    selectedId: ids.workflows.receipt,
    onSelectWorkflow: () => undefined,
    connection: { state: 'connected', status: { state: 'running', restarts: 0 } },
    ping: { state: 'ok', ms: 3 },
    model: { provider: 'anthropic', model: 'claude-opus-5-5' },
    onRestart: () => undefined,
    chatOpen: false,
    onToggleChat: () => undefined,
  },
}
export default meta
type Story = StoryObj<typeof TopBar>

export const Connected: Story = {}
export const RecipesTab: Story = { args: { tab: 'recipes' } }
export const SettingsTab: Story = { args: { tab: 'settings' } }
export const Connecting: Story = { args: { connection: { state: 'connecting' }, ping: { state: 'pending' } } }
export const Reconnecting: Story = { args: { connection: { state: 'reconnecting' }, ping: { state: 'pending' } } }
export const EngineRestarting: Story = { args: { connection: { state: 'reconnecting', status: { state: 'restarting', restarts: 2 } } } }
export const EngineStopped: Story = { args: { connection: { state: 'engine_stopped', status: { state: 'stopped', error: 'crashed', restarts: 6 } } } }
export const RestartInProgress: Story = { args: { connection: { state: 'engine_stopped', status: { state: 'stopped', error: 'start_timeout', restarts: 1 } }, restarting: true } }
export const NoModel: Story = { args: { model: undefined } }
export const NoWorkflows: Story = { args: { list: { status: 'ready', workflows: [], refresh }, selectedId: undefined } }
export const DrawerOpen: Story = { args: { chatOpen: true } }
