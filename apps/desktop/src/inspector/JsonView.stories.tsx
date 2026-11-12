import type { Meta, StoryObj } from '@storybook/react-vite'
import { hostileValue } from '../fixtures/hostile'
import { JsonView } from './JsonView'

function nested(depth: number): unknown {
  let value: unknown = 'bottom'
  for (let level = 0; level < depth; level += 1) value = { level, inner: value }
  return value
}

const meta = {
  title: 'Inspector/JsonView',
  component: JsonView,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof JsonView>

export default meta

type Story = StoryObj<typeof meta>

export const Small: Story = {
  args: { value: { vendor: 'Cafe Mori', amount: 12800, date: '2026-11-12', paid: true, note: null, tags: ['lunch', 'team'], meta: { pages: 1, source: { kind: 'pdf' } } } },
}

export const TemplateReferences: Story = {
  args: { value: { file: '{{watch.output.file}}', row: ['{{extract.output.date}}', '{{extract.output.vendor}}', 'total {{extract.output.amount}} yen'], broken: '{{ nothing }}' } },
}

export const TenThousandItems: Story = { args: { value: Array.from({ length: 10_000 }, (_, index) => ({ id: index, label: `row ${index}` })) } }

export const WideObject: Story = { args: { value: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`field_${index}`, index])) } }

export const LongString: Story = { args: { value: { text: `${'A long line of extracted text. '.repeat(200)}END` } } }

export const OneMegabyteString: Story = { args: { value: 'x'.repeat(1_000_000) } }

export const DeepNesting: Story = { args: { value: nested(60) } }

export const HostileData: Story = { args: { value: hostileValue() } }
