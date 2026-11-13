import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { catalog } from '../src/fixtures'
import { hostileRecipes, recipeInfos } from '../src/fixtures/recipes'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { RecipeGallery, type RecipeGalleryProps } from '../src/recipes/RecipeGallery'
import { violations } from './axe'
import { renderThemed } from './render'

const t = createTranslator('ko')

function setup(props: Partial<RecipeGalleryProps> = {}, locale: 'ko' | 'en' = 'ko') {
  const onChoose = vi.fn()
  const onRetry = vi.fn()
  const view = renderThemed(<RecipeGallery recipes={recipeInfos} catalog={catalog} onChoose={onChoose} onRetry={onRetry} {...props} />, { locale })
  return { onChoose, onRetry, view, user: userEvent.setup() }
}

const cards = () => screen.getAllByRole('article')

describe('RecipeGallery list', () => {
  it('lists the eight recipes with title, description and tags in the current language', () => {
    setup()
    expect(cards()).toHaveLength(8)
    for (const recipe of recipeInfos) {
      expect(screen.getByRole('heading', { name: recipe.title.ko })).toBeTruthy()
      expect(screen.getByText(recipe.description.ko)).toBeTruthy()
    }
    const first = within(cards()[0]!)
    for (const tag of recipeInfos[0]!.tags) expect(first.getByText(tag)).toBeTruthy()
  })

  it('shows the English text when the language is English', () => {
    setup({}, 'en')
    expect(screen.getByRole('heading', { name: recipeInfos[0]!.title.en })).toBeTruthy()
    expect(screen.getByText(recipeInfos[0]!.description.en)).toBeTruthy()
    expect(screen.queryByText(recipeInfos[0]!.title.ko)).toBeNull()
  })

  it('shows an icon with the node title for each node type of a recipe', () => {
    setup()
    const receipt = within(cards()[0]!)
    const icons = receipt.getByRole('list', { name: ko['recipes.card.steps'] })
    const labels = within(icons).getAllByRole('img').map((icon) => icon.getAttribute('aria-label'))
    expect(labels).toEqual(recipeInfos[0]!.nodeTypes.map((type) => catalog.find((node) => node.type === type)!.title))
  })

  it('falls back to the node type for an icon when the catalog does not know it', () => {
    setup({ recipes: hostileRecipes, catalog: [] })
    const labels = screen.getAllByRole('img').map((icon) => icon.getAttribute('aria-label'))
    expect(labels).toContain('trigger.manual@1')
  })

  it('notes a recipe that needs a connection, and only that', () => {
    setup()
    const notes = screen.getAllByText(ko['recipes.card.needsConnection'])
    expect(notes).toHaveLength(recipeInfos.filter((recipe) => recipe.needsConnection).length)
    expect(within(cards()[0]!).queryByText(ko['recipes.card.needsConnection'])).toBeNull()
  })

  it('notes the spreadsheet recipes like every other recipe that needs a connection, and gives them the transfer mark', () => {
    setup()
    for (const id of ['receipt-folder-to-google-sheet', 'receipt-folder-to-excel']) {
      const info = recipeInfos.find((recipe) => recipe.id === id)!
      const card = within(screen.getByRole('heading', { name: info.title.ko }).closest('article') as HTMLElement)
      expect(info.needsConnection, id).toBe(true)
      expect(card.getByText(ko['recipes.card.needsConnection']), id).toBeTruthy()
      expect(card.getByText(ko['badge.externalTransfer']), id).toBeTruthy()
      expect(card.getByText(info.description.ko), id).toBeTruthy()
    }
  })

  it('draws the table icon of the CSV step for the Google Sheets and Excel steps, and not the plain square', () => {
    setup()
    const lastIcon = (index: number) => within(cards()[index]!).getAllByRole('img').at(-1)!.querySelector('path')!.getAttribute('d')
    const table = lastIcon(0)
    expect(table).toBeTruthy()
    const square = 'M3 3h10v10H3z'
    expect(within(cards()[6]!).getAllByRole('img').at(-1)!.getAttribute('aria-label')).toBe(catalog.find((node) => node.type === 'google.sheets.append@1')?.title ?? 'google.sheets.append@1')
    expect(lastIcon(6)).toBe(table)
    expect(lastIcon(7)).toBe(table)
    expect(lastIcon(6)).not.toBe(square)
  })

  it('shows the spreadsheet recipes in English without any Korean text', () => {
    setup({}, 'en')
    expect(screen.getByRole('heading', { name: 'Receipt folder to Google Sheet' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Receipt folder to Excel' })).toBeTruthy()
    expect(screen.queryByText(/구글|엑셀/)).toBeNull()
  })

  it('shows the external transfer badge for a recipe that uses llm.extract, and only that', () => {
    setup()
    const badges = screen.getAllByText(ko['badge.externalTransfer'])
    expect(badges).toHaveLength(4)
    expect(within(cards()[0]!).getByText(ko['badge.externalTransfer'])).toBeTruthy()
    expect(within(cards()[2]!).queryByText(ko['badge.externalTransfer'])).toBeNull()
  })

  it('calls onChoose with the id of the card whose button was pressed', async () => {
    const { user, onChoose } = setup()
    await user.click(screen.getByRole('button', { name: t('recipes.card.chooseLabel', { title: recipeInfos[2]!.title.ko }) }))
    expect(onChoose).toHaveBeenCalledWith(recipeInfos[2]!.id)
  })
})

describe('RecipeGallery search and tags', () => {
  it('filters by text and shows a message when nothing matches', async () => {
    const { user } = setup()
    await user.type(screen.getByRole('searchbox', { name: ko['recipes.search'] }), '영수증')
    expect(cards()).toHaveLength(4)
    await user.clear(screen.getByRole('searchbox', { name: ko['recipes.search'] }))
    await user.type(screen.getByRole('searchbox', { name: ko['recipes.search'] }), 'zzzzzz')
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(screen.getByText(ko['recipes.noMatch'])).toBeTruthy()
  })

  it('filters by tag with toggle buttons and shows which are on', async () => {
    const { user } = setup()
    const group = screen.getByRole('group', { name: ko['recipes.tags'] })
    const slack = within(group).getByRole('button', { name: 'slack' })
    expect(slack.getAttribute('aria-pressed')).toBe('false')
    await user.click(slack)
    expect(slack.getAttribute('aria-pressed')).toBe('true')
    expect(cards().length).toBe(recipeInfos.filter((recipe) => recipe.tags.includes('slack')).length)
    await user.click(slack)
    expect(cards()).toHaveLength(8)
  })

  it('treats a search with a regular expression character as plain text', async () => {
    const { user } = setup()
    await user.type(screen.getByRole('searchbox', { name: ko['recipes.search'] }), '?*+')
    expect(screen.getByText(ko['recipes.noMatch'])).toBeTruthy()
  })
})

describe('RecipeGallery states', () => {
  it('shows a message for an empty list', () => {
    setup({ recipes: [] })
    expect(screen.getByText(ko['recipes.empty'])).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('shows loading as a status and no cards', () => {
    setup({ status: 'loading', recipes: [] })
    expect(screen.getByRole('status').textContent).toContain(ko['recipes.loading'])
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('shows a load error with a retry button', async () => {
    const { user, onRetry } = setup({ status: 'error', recipes: [] })
    expect(screen.getByRole('alert').textContent).toContain(ko['recipes.loadError'])
    await user.click(screen.getByRole('button', { name: ko['recipes.retry'] }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('RecipeGallery hostile text', () => {
  it('renders HTML, links and bidi controls from the server as text', () => {
    const { view } = setup({ recipes: hostileRecipes })
    expect(view.container.querySelector('a, img, script, svg[onload]')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x onerror=')
    expect(view.container.querySelectorAll('[data-invisible]').length).toBeGreaterThan(0)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('has no axe violations', async () => {
    const { view } = setup()
    expect(await violations(view.container)).toEqual([])
    const hostile = setup({ recipes: hostileRecipes })
    expect(await violations(hostile.view.container)).toEqual([])
  })

  it('has an English heading', () => {
    setup({}, 'en')
    expect(screen.getByRole('heading', { name: en['recipes.heading'] })).toBeTruthy()
  })
})
