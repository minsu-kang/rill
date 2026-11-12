import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/ConnectionsSection', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

export const Empty: Story = { args: { section: 'connections' } }
export const Filled: Story = {
  args: {
    section: 'connections',
    init: {
      settings: fakeSettings({
        connections: [
          { name: 'team-alerts', kind: 'slack' },
          { name: 'billing-api', kind: 'http' },
          { name: 'shop-webhook', kind: 'webhookSecret' },
        ],
      }),
    },
  },
}
export const NoKeychain: Story = { args: { section: 'connections', init: { settings: fakeSettings({ encryptionAvailable: false }) } } }
