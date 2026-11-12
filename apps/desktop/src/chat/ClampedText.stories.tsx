import type { Meta, StoryObj } from '@storybook/react-vite'
import { ClampedText } from './ClampedText'

const meta = {
  title: 'Chat/ClampedText',
  component: ClampedText,
  decorators: [
    (Story) => (
      <div style={{ width: 420, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClampedText>

export default meta

type Story = StoryObj<typeof meta>

export const Short: Story = { args: { text: '폴더에 PDF가 들어오면 CSV에 기록해요.' } }

export const Long: Story = { args: { text: `${'폴더에 새 영수증이 들어올 때마다 금액과 날짜를 뽑아서 장부에 한 줄씩 추가해요. '.repeat(12)}`, max: 200 } }

export const TenThousandCharacters: Story = { name: '10,000 characters', args: { text: 'long text '.repeat(1000), max: 200 } }

export const HostileText: Story = {
  name: 'Hostile text',
  args: {
    text: '<img src=x onerror=alert(1)> <a href="https://evil.example/pay">Click to confirm</a> **bold** [link](https://evil.example) ‮txt.exe and a​zero​width\u0007bell',
  },
}
