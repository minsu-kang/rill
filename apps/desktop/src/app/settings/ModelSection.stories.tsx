import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/ModelSection', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

const configured = fakeSettings({ configuredProviders: ['anthropic', 'openai'] })

export const Configured: Story = { args: { section: 'model', init: { settings: configured } } }
export const NothingConfigured: Story = { args: { section: 'model' } }
export const EngineRestarting: Story = { args: { section: 'model', init: { settings: configured, engine: { state: 'restarting', restarts: 1 } } } }
export const EngineStopped: Story = { args: { section: 'model', init: { settings: configured, engine: { state: 'stopped', error: 'crashed', restarts: 6 } } } }
