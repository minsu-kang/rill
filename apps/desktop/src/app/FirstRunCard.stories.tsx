import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../engine/fake-host'
import { FirstRunCard } from './FirstRunCard'

const meta: Meta<typeof FirstRunCard> = { title: 'App/FirstRunCard', component: FirstRunCard, args: { settings: fakeSettings(), onOpen: () => undefined } }
export default meta
type Story = StoryObj<typeof FirstRunCard>

export const NothingDone: Story = {}
export const FolderDone: Story = { args: { settings: fakeSettings({ allowedFolders: ['/Users/demo/Receipts'] }) } }
export const KeyDone: Story = { args: { settings: fakeSettings({ configuredProviders: ['anthropic'] }) } }
export const RequiredDoneSlackOpen: Story = { args: { settings: fakeSettings({ allowedFolders: ['/Users/demo/Receipts'], configuredProviders: ['anthropic'] }) } }
export const EverythingDone: Story = {
  args: { settings: fakeSettings({ allowedFolders: ['/a'], configuredProviders: ['anthropic'], connections: [{ name: 'ops', kind: 'slack' }] }) },
}
