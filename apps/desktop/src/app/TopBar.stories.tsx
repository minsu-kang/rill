import type { Meta, StoryObj } from '@storybook/react-vite'
import { TopBar } from './TopBar'

const meta: Meta<typeof TopBar> = {
  title: 'App/TopBar',
  component: TopBar,
  args: {
    tab: 'workflows',
    onTab: () => undefined,
    connection: { state: 'connected', status: { state: 'running', restarts: 0 } },
    ping: { state: 'ok', ms: 3 },
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
export const DrawerOpen: Story = { args: { chatOpen: true } }
