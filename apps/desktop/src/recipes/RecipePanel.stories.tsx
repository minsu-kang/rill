import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { createFakeClient } from '../engine/fake-client'
import { withRecipeMethods, type FakeRecipeData } from '../engine/fake-recipes'
import { catalog, fakeData } from '../fixtures'
import { failingInstantiate, fixtureRecipeData, recipeProblemSets } from '../fixtures/recipes'
import { RecipePanel, type RecipePanelProps } from './RecipePanel'

const CONNECTIONS: RecipePanelProps['connections'] = [
  { name: 'slack-ops', kind: 'slack' },
  { name: 'slack-dev', kind: 'slack' },
  { name: 'api-main', kind: 'http' },
]

function Wired({ data, ...rest }: Omit<RecipePanelProps, 'client'> & { data: FakeRecipeData }) {
  const client = useMemo(() => withRecipeMethods(createFakeClient(fakeData), data), [data])
  const [log, setLog] = useState<string[]>([])
  const note = (line: string): void => setLog((previous) => [line, ...previous].slice(0, 5))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <RecipePanel {...rest} client={client} onDeployed={(id) => note(`onDeployed ${id}`)} onAction={(action, id) => note(`onAction ${action} ${id}`)} />
      {log.length > 0 && (
        <ol style={{ margin: 0, padding: 'var(--space-2) var(--space-4)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
          {log.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      )}
    </div>
  )
}

const DATA = fixtureRecipeData()

const meta = {
  title: 'Recipes/RecipePanel',
  component: Wired,
  args: { data: DATA, catalog, connections: CONNECTIONS, onPickPath: async (kind) => (kind === 'folder' ? '/Users/demo/Receipts' : '/Users/demo/ledger.csv') },
  decorators: [
    (Story) => (
      <div style={{ padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Wired>

export default meta

type Story = StoryObj<typeof meta>

type Play = NonNullable<Story['play']>
type PlayContext = Parameters<Play>[0]

async function openRecipe({ canvas, userEvent }: PlayContext, index: number): Promise<void> {
  const buttons = await canvas.findAllByRole('button', { name: /고르기|Choose/ })
  await userEvent.click(buttons[index]!)
}

export const TryItYourself: Story = {}

export const FormOpened: Story = { play: async (context) => openRecipe(context, 2) }

export const ServerProblemsAtFields: Story = {
  args: { data: { ...DATA, instantiate: failingInstantiate(['watchFolder: not_absolute_path', 'csvFile: wrong_extension', ...recipeProblemSets.pathIssues]) } },
  play: async (context) => {
    const { canvas, userEvent } = context
    await openRecipe(context, 1)
    const inputs = await canvas.findAllByRole('textbox')
    await userEvent.type(inputs[0]!, 'relative/dir')
    await userEvent.type(inputs[2]!, '/Users/demo/ledger.txt')
    await userEvent.type(inputs[3]!, '250')
    await userEvent.selectOptions((await canvas.findAllByRole('combobox'))[0]!, 'slack-ops')
    await userEvent.click(await canvas.findByRole('button', { name: /초안|draft/i }))
  },
}
