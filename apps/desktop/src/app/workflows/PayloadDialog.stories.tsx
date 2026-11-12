import type { Meta, StoryObj } from '@storybook/react-vite'
import { PayloadDialog } from './PayloadDialog'

const meta: Meta<typeof PayloadDialog> = {
  title: 'App/Workflows/PayloadDialog',
  component: PayloadDialog,
  args: { triggerType: 'trigger.webhook@1', mode: 'dry', onSubmit: () => undefined, onCancel: () => undefined },
}
export default meta
type Story = StoryObj<typeof PayloadDialog>

export const DryRunWebhook: Story = {}
export const DryRunFolder: Story = { args: { triggerType: 'trigger.folderWatch@1' } }
export const DryRunManual: Story = { args: { triggerType: 'trigger.manual@1' } }
export const RunNowInput: Story = { args: { mode: 'live', triggerType: 'trigger.folderWatch@1' } }
export const Busy: Story = { args: { busy: true } }
export const WithEngineError: Story = { args: { error: '요청을 처리하지 못했어요. 엔진 연결을 확인하고 다시 시도해 주세요.' } }
export const InvalidJson: Story = {
  play: async ({ canvas, userEvent }) => {
    const field = await canvas.findByRole('textbox')
    await userEvent.clear(field)
    await userEvent.type(field, '{{ broken')
    await userEvent.click(canvas.getByRole('dialog').querySelectorAll('button')[1]!)
  },
}
