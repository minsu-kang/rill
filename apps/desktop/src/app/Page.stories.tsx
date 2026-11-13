import type { Meta, StoryObj } from '@storybook/react-vite'
import { Page } from './Page'

const meta: Meta<typeof Page> = { title: 'App/Page', component: Page }
export default meta
type Story = StoryObj<typeof Page>

export const Padding: Story = {
  render: () => (
    <Page>
      <div style={{ padding: 16, border: '1px dashed var(--border-strong)', color: 'var(--text-primary)' }}>Content of a screen. The page keeps 24px from the window edge, and 16px under 700px.</div>
    </Page>
  ),
}
