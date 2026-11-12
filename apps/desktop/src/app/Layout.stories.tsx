import type { Meta, StoryObj } from '@storybook/react-vite'
import { Layout } from './Layout'

const box = (text: string) => <p style={{ margin: 16 }}>{text}</p>

const meta: Meta<typeof Layout> = {
  title: 'App/Layout',
  component: Layout,
  args: {
    topBar: <header data-rill-region="topbar" style={{ padding: 12, borderBottom: '1px solid var(--border-default)' }}>상단 막대</header>,
    chat: box('대화 영역'),
    main: box('작업 영역'),
    chatOpen: false,
    onCloseChat: () => undefined,
  },
  parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof Layout>

export const Wide: Story = {}
export const DrawerOpen: Story = { args: { chatOpen: true } }
