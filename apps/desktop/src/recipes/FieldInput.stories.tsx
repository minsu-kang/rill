import type { RecipeParamInfo } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { recipeInfos } from '../fixtures/recipes'
import { FieldInput, type FieldInputProps } from './FieldInput'

const param = (recipeId: string, paramId: string): RecipeParamInfo => recipeInfos.find((recipe) => recipe.id === recipeId)!.params.find((item) => item.id === paramId)!

const CONNECTIONS = [
  { name: 'slack-ops', kind: 'slack' },
  { name: 'slack-dev', kind: 'slack' },
  { name: 'api-main', kind: 'http' },
] as const

function Stateful(props: FieldInputProps) {
  const [value, setValue] = useState(props.value)
  return <FieldInput {...props} value={value} onChange={setValue} />
}

const meta = {
  title: 'Recipes/FieldInput',
  component: FieldInput,
  args: { param: param('receipt-big-amount-alert', 'watchFolder'), value: '', connections: CONNECTIONS, onChange: () => undefined },
  render: (args) => <Stateful {...args} />,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 520, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FieldInput>

export default meta

type Story = StoryObj<typeof meta>

export const Folder: Story = {}
export const FolderWithBrowseButton: Story = { args: { onPickPath: async () => '/Users/demo/Picked' } }
export const FileWithExtension: Story = { args: { param: param('receipt-big-amount-alert', 'csvFile'), onPickPath: async () => '/Users/demo/ledger.csv' } }
export const GlobWithDefault: Story = { args: { param: param('receipt-big-amount-alert', 'glob'), value: '*.pdf' } }
export const NumberWithRange: Story = { args: { param: param('receipt-big-amount-alert', 'threshold') } }
export const CronWithPresets: Story = { args: { param: param('daily-health-check', 'schedule'), value: '0 9 * * 1-5' } }
export const CronCustomText: Story = { args: { param: param('daily-health-check', 'schedule'), value: '5 4 * * *' } }
export const Url: Story = { args: { param: param('daily-health-check', 'url') } }
export const TextWithDefault: Story = { args: { param: param('monthly-reminder', 'message'), value: String(param('monthly-reminder', 'message').default) } }
export const ConnectionSelect: Story = { args: { param: param('receipt-big-amount-alert', 'slackConnection') } }
export const NoMatchingConnection: Story = { args: { param: param('receipt-big-amount-alert', 'slackConnection'), connections: [{ name: 'api-main', kind: 'http' }] } }
export const ErrorAtField: Story = { args: { value: 'relative/dir', error: 'recipes.rule.not_absolute_path' } }
export const UnknownRuleWithRawId: Story = { args: { value: 'x', error: 'recipes.rule.generic', raw: 'a_rule_from_the_future' } }
export const TemplateTextHint: Story = { args: { param: param('monthly-reminder', 'message'), value: 'hello {{x.output}}' } }
