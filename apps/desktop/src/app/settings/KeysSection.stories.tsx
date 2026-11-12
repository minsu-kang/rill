import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/KeysSection', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

export const Empty: Story = { args: { section: 'keys' } }
export const SomeConfigured: Story = { args: { section: 'keys', init: { settings: fakeSettings({ configuredProviders: ['anthropic', 'gemini'] }) } } }
export const NoKeychain: Story = { args: { section: 'keys', init: { settings: fakeSettings({ encryptionAvailable: false }) } } }
