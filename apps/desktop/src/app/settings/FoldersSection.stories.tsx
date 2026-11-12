import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/FoldersSection', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

export const Empty: Story = { args: { section: 'folders' } }
export const Filled: Story = { args: { section: 'folders', init: { settings: fakeSettings({ allowedFolders: ['/Users/demo/Receipts', '/Users/demo/Documents'] }) } } }
export const AtTheLimit: Story = {
  args: { section: 'folders', init: { settings: fakeSettings({ allowedFolders: Array.from({ length: 50 }, (_, index) => `/Users/demo/Folder-${index + 1}`) }) } },
}
export const CancelledDialog: Story = { args: { section: 'folders', init: { folderPicks: [undefined] } } }
