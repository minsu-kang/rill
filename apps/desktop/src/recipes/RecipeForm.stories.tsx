import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { hostileRecipes, recipeInfos, recipeProblemSets } from '../fixtures/recipes'
import { initialValues, type FormValues } from './model/values'
import { RecipeForm, type RecipeFormProps } from './RecipeForm'

const CONNECTIONS = [
  { name: 'slack-ops', kind: 'slack' },
  { name: 'slack-dev', kind: 'slack' },
  { name: 'api-main', kind: 'http' },
] as const

const byId = (id: string) => recipeInfos.find((recipe) => recipe.id === id)!

function Stateful(props: RecipeFormProps) {
  const [values, setValues] = useState<FormValues>(props.values)
  return <RecipeForm {...props} values={values} onValuesChange={setValues} />
}

const FILLED: FormValues = { watchFolder: 'relative/dir', glob: '*.pdf', csvFile: '/Users/demo/ledger.txt', threshold: '250', slackConnection: 'slack-ops' }

const meta = {
  title: 'Recipes/RecipeForm',
  component: RecipeForm,
  args: { recipe: recipeInfos[0]!, values: initialValues(recipeInfos[0]!.params), connections: CONNECTIONS, onValuesChange: () => undefined, onSubmit: () => undefined, onBack: () => undefined },
  render: (args) => <Stateful {...args} />,
  decorators: [
    (Story) => (
      <div style={{ padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RecipeForm>

export default meta

type Story = StoryObj<typeof meta>

const formOf = (id: string): Story => ({ args: { recipe: byId(id), values: initialValues(byId(id).params) } })

export const ReceiptFolderToCsv: Story = formOf('receipt-folder-to-csv')
export const ReceiptBigAmountAlert: Story = formOf('receipt-big-amount-alert')
export const DailyHealthCheck: Story = formOf('daily-health-check')
export const WebhookToSlack: Story = formOf('webhook-to-slack')
export const MonthlyReminder: Story = formOf('monthly-reminder')
export const FailureWebhookAlert: Story = formOf('failure-webhook-alert')
export const WithBrowseButtons: Story = { args: { ...formOf('receipt-big-amount-alert').args, onPickPath: async (kind) => (kind === 'folder' ? '/Users/demo/Receipts' : '/Users/demo/ledger.csv') } }
export const ProblemsAtFields: Story = { args: { recipe: recipeInfos[1]!, values: FILLED, problems: [...recipeProblemSets.folderAndFile, ...recipeProblemSets.numberRules.slice(0, 1)] } }
export const PathAndConnectionIssues: Story = { args: { recipe: recipeInfos[1]!, values: FILLED, problems: [...recipeProblemSets.pathIssues, ...recipeProblemSets.connectionIssues] } }
export const ConfigAndStructureIssues: Story = { args: { recipe: recipeInfos[1]!, values: FILLED, problems: [...recipeProblemSets.configIssues, 'cycle at /', 'unknown_ref_node at /nodes/3/config/left'] } }
export const UnknownRulesAndParams: Story = { args: { recipe: recipeInfos[1]!, values: FILLED, problems: recipeProblemSets.unknown } }
export const NoMatchingConnection: Story = { args: { ...formOf('webhook-to-slack').args, connections: [{ name: 'api-main', kind: 'http' }] } }
export const FailureNotice: Story = { args: { ...formOf('webhook-to-slack').args, failureKey: 'recipes.error.generic' } }
export const Submitting: Story = { args: { recipe: recipeInfos[2]!, values: { schedule: '0 9 * * 1-5', url: 'https://example.test/health', slackConnection: 'slack-ops' }, submitting: true } }
export const HostileRecipeText: Story = { args: { recipe: hostileRecipes[0]!, values: initialValues(hostileRecipes[0]!.params) } }
