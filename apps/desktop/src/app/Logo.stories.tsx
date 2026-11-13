import type { Meta, StoryObj } from '@storybook/react-vite'
import { Logo } from './Logo'

const meta: Meta<typeof Logo> = {
  title: 'App/Logo',
  component: Logo,
}
export default meta
type Story = StoryObj<typeof Logo>

export const Default: Story = { args: { size: 24 } }
export const Large: Story = { args: { size: 160 } }
export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
      {[16, 24, 32, 48, 96].map((size) => (
        <Logo key={size} size={size} />
      ))}
    </div>
  ),
}
export const SmallVariantLarge: Story = { args: { size: 96, variant: 'small' } }
