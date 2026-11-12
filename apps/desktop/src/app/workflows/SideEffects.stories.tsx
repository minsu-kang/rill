import type { Meta, StoryObj } from '@storybook/react-vite'
import { SideEffects } from './SideEffects'

const meta: Meta<typeof SideEffects> = { title: 'App/Workflows/SideEffects', component: SideEffects }
export default meta
type Story = StoryObj<typeof SideEffects>

export const Loading: Story = { args: { state: { status: 'loading' } } }
export const LoadError: Story = { args: { state: { status: 'error' } } }
export const CatalogUnknown: Story = { args: { state: { status: 'unknown' } } }
export const NoEffects: Story = { args: { state: { status: 'ready', effects: [] } } }
export const WithEffects: Story = {
  args: {
    state: {
      status: 'ready',
      effects: [
        { id: 'extract', title: 'Extract fields with AI', badges: ['externalTransfer'] },
        { id: 'send', title: 'HTTP request', badges: ['network'] },
        { id: 'both', title: 'Extract and send', badges: ['externalTransfer', 'network', 'writesFile'] },
      ],
    },
  },
}
