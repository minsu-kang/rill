import type { Meta, StoryObj } from '@storybook/react-vite'
import { ids } from '../../fixtures'
import { ActionsStage, STAGE_MANUAL_ID } from './ActionsStage'

const meta: Meta<typeof ActionsStage> = { title: 'App/Workflows/WorkflowActions', component: ActionsStage }
export default meta
type Story = StoryObj<typeof ActionsStage>

type Play = NonNullable<Story['play']>

const open =
  (action: string): Play =>
  async ({ canvasElement, userEvent }) => {
    let found: HTMLButtonElement | null = null
    for (let tries = 0; tries < 50 && found === null; tries += 1) {
      found = canvasElement.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
      if (found === null) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (found === null) throw new Error(`no ${action} button`)
    await userEvent.click(found)
  }

export const Inactive: Story = { args: { workflowId: ids.workflows.webhook } }
export const Active: Story = { args: { workflowId: ids.workflows.receipt } }
export const ManualTrigger: Story = { args: { workflowId: STAGE_MANUAL_ID } }
export const PayloadDialogWebhook: Story = { args: { workflowId: ids.workflows.webhook }, play: open('dryRun') }
export const PayloadDialogFolder: Story = { args: { workflowId: ids.workflows.receipt }, play: open('dryRun') }
export const ConfirmWithSideEffects: Story = { args: { workflowId: STAGE_MANUAL_ID }, play: open('runNow') }
export const ConfirmDeactivate: Story = { args: { workflowId: ids.workflows.receipt }, play: open('deactivate') }
export const FailedActivation: Story = { args: { workflowId: ids.workflows.webhook, control: { activationError: true } }, play: open('activate') }
export const InvalidPayload: Story = {
  args: { workflowId: STAGE_MANUAL_ID },
  play: async (context) => {
    await open('dryRun')(context)
    const field = await context.canvas.findByRole('textbox')
    await context.userEvent.clear(field)
    await context.userEvent.type(field, '{{ nope')
    const dialog = context.canvas.getByRole('dialog')
    await context.userEvent.click(dialog.querySelectorAll('button')[1]!)
  },
}
export const WaitingForTheEngine: Story = {
  args: { workflowId: STAGE_MANUAL_ID, hangStart: true },
  play: async (context) => {
    await open('dryRun')(context)
    const dialog = await context.canvas.findByRole('dialog')
    await context.userEvent.click(dialog.querySelectorAll('button')[1]!)
  },
}
