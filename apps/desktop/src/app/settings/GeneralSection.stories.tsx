import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/GeneralSection', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

export const Running: Story = { args: { section: 'general' } }
export const OpenAtLogin: Story = { args: { section: 'general', init: { settings: fakeSettings({ openAtLogin: true }) } } }
export const Stopped: Story = { args: { section: 'general', init: { engine: { state: 'stopped', error: 'crashed', restarts: 6 } } } }
export const NoKeychainStopped: Story = { args: { section: 'general', init: { settings: fakeSettings({ encryptionAvailable: false }), engine: { state: 'stopped', error: 'no_keychain', restarts: 0 } } } }
