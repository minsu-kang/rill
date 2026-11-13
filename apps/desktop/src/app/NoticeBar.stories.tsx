import type { Meta, StoryObj } from '@storybook/react-vite'
import { NoticeBar } from './NoticeBar'

const meta: Meta<typeof NoticeBar> = {
  title: 'App/NoticeBar',
  component: NoticeBar,
  args: { onDismiss: () => undefined },
  decorators: [(Story) => <div style={{ position: 'relative', height: 120 }}><Story /></div>],
}
export default meta
type Story = StoryObj<typeof NoticeBar>

export const Nothing: Story = { args: { notice: undefined } }
export const Reminder: Story = { args: { notice: { id: 1, key: 'app.notice.waitAndRetry' } } }
export const FilePath: Story = { args: { notice: { id: 2, key: 'app.notice.filePath', vars: { path: '/Users/demo/Receipts/receipt-001.pdf' } } } }
export const HostilePath: Story = { args: { notice: { id: 3, key: 'app.notice.filePath', vars: { path: '<img src=x onerror=alert(1)> ‹U+202E›txt.exe' } } } }
export const Failure: Story = { args: { notice: { id: 4, key: 'app.notice.actionFailed' } } }

const goToConnections = { key: 'app.notice.reconnect.action', run: () => undefined } as const

export const ReconnectGoogle: Story = { args: { notice: { id: 5, key: 'app.notice.reconnect', vars: { provider: 'Google' }, action: goToConnections } } }
export const ReconnectMicrosoft: Story = { args: { notice: { id: 6, key: 'app.notice.reconnect', vars: { provider: 'Microsoft' }, action: goToConnections } } }
export const ReconnectBoth: Story = { args: { notice: { id: 7, key: 'app.notice.reconnectBoth', action: goToConnections } } }
export const ReconnectNarrow: Story = {
  args: { notice: { id: 8, key: 'app.notice.reconnectBoth', action: goToConnections } },
  decorators: [(Story) => <div style={{ position: 'relative', height: 200, width: 360 }}><Story /></div>],
}
