import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/SettingsScreen', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

const filled = fakeSettings({
  allowedFolders: ['/Users/demo/Receipts', '/Users/demo/Documents'],
  configuredProviders: ['anthropic', 'openai'],
  connections: [
    { name: 'team-alerts', kind: 'slack' },
    { name: 'billing-api', kind: 'http' },
  ],
})

export const FirstRun: Story = { args: {} }
export const Filled: Story = { args: { init: { settings: filled } } }
export const NoKeychain: Story = {
  args: {
    section: 'keys',
    init: { settings: fakeSettings({ encryptionAvailable: false }), engine: { state: 'stopped', error: 'no_keychain', restarts: 0 } },
  },
}
export const EngineRestarting: Story = { args: { section: 'general', init: { settings: filled, engine: { state: 'restarting', restarts: 1 } } } }
export const EngineStopped: Story = { args: { section: 'general', init: { settings: filled, engine: { state: 'stopped', error: 'crashed', restarts: 6 } } } }
export const LoadError: Story = { args: { failLoad: true } }
