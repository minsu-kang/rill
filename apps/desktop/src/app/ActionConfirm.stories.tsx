import type { Meta, StoryObj } from '@storybook/react-vite'
import { createFakeClient } from '../engine/fake-client'
import { catalog, fakeData, ids } from '../fixtures'
import { ActionConfirm } from './ActionConfirm'

const meta: Meta<typeof ActionConfirm> = {
  title: 'App/ActionConfirm',
  component: ActionConfirm,
  args: { client: createFakeClient(fakeData), catalog, onAnswer: () => undefined },
}
export default meta
type Story = StoryObj<typeof ActionConfirm>

export const RetryWithEffects: Story = {
  args: { title: 'app.retry.title', message: 'app.confirm.retry', confirmLabel: 'app.retry.confirm', effectsOf: ids.workflows.receipt },
}
export const RetryWithoutCatalog: Story = {
  args: { title: 'app.retry.title', message: 'app.confirm.retry', confirmLabel: 'app.retry.confirm', effectsOf: ids.workflows.receipt, catalog: [] },
}
export const RetryDryRun: Story = { args: { title: 'app.retry.title', message: 'app.confirm.retry', confirmLabel: 'app.retry.confirm' } }
export const Deactivate: Story = { args: { title: 'app.deactivate.title', message: 'app.confirm.deactivate', confirmLabel: 'app.deactivate.confirm' } }
