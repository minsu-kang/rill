import type { Meta, StoryObj } from '@storybook/react-vite'
import { catalog } from '../fixtures'
import { hostileRecipes, recipeInfos } from '../fixtures/recipes'
import { RecipeGallery } from './RecipeGallery'

const meta = {
  title: 'Recipes/RecipeGallery',
  component: RecipeGallery,
  args: { recipes: recipeInfos, catalog, onChoose: () => undefined, onRetry: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RecipeGallery>

export default meta

type Story = StoryObj<typeof meta>

export const EveryRecipe: Story = {}
export const SpreadsheetRecipes: Story = { args: { recipes: recipeInfos.filter((recipe) => recipe.tags.includes('spreadsheet')) } }
export const SearchWithNoMatch: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByRole('searchbox'), 'zzzzzz')
  },
}
export const TagFilterOn: Story = {
  play: async ({ canvas, userEvent }) => {
    const buttons = await canvas.findAllByRole('button', { pressed: false })
    await userEvent.click(buttons[0]!)
  },
}
export const Empty: Story = { args: { recipes: [] } }
export const Loading: Story = { args: { recipes: [], status: 'loading' } }
export const LoadError: Story = { args: { recipes: [], status: 'error' } }
export const HostileText: Story = { args: { recipes: [...hostileRecipes, ...recipeInfos.slice(0, 2)] } }
