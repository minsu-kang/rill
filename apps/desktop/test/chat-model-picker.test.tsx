import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../src/chat/ModelPicker'
import { models, modelsNothingConfigured } from '../src/fixtures/plan'
import { renderThemed } from './render'

describe('ModelPicker', () => {
  it('groups the models by provider, in the order of the provider list', () => {
    renderThemed(<ModelPicker models={models} />, { locale: 'en' })
    const headings = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)
    expect(headings.map((text) => text?.replace('Key needed', '').trim())).toEqual(['Anthropic', 'OpenAI', 'Google Gemini', 'xAI Grok', 'Meta'])
    const anthropic = screen.getByRole('group', { name: 'Anthropic' })
    expect(within(anthropic).getAllByRole('button').map((button) => button.textContent)).toEqual([
      expect.stringContaining('Claude Opus 5.5'),
      expect.stringContaining('Claude Sonnet 5.5'),
      expect.stringContaining('Claude Haiku 5'),
    ])
  })

  it('marks the active model and says so in words', () => {
    renderThemed(<ModelPicker models={models} />, { locale: 'en' })
    const active = screen.getByRole('button', { name: /Claude Opus 5\.5/ })
    expect(active.getAttribute('aria-current')).toBe('true')
    expect(active.textContent).toContain('In use')
    expect(screen.getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'true')).toHaveLength(1)
  })

  it('disables the provider that has no key, labels it and says which variable to set', () => {
    renderThemed(<ModelPicker models={models} />, { locale: 'en' })
    const grok = screen.getByRole('group', { name: 'xAI Grok' })
    expect(grok.textContent).toContain('Key needed')
    expect(grok.textContent).toContain('XAI_API_KEY')
    for (const button of within(grok).getAllByRole('button')) expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  it('calls onSelect for a configured model and never for an unconfigured one or the active one', () => {
    const onSelect = vi.fn()
    renderThemed(<ModelPicker models={models} onSelect={onSelect} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: /GPT-6\.1 Sol/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-6.1-sol' })
    fireEvent.click(screen.getByRole('button', { name: /Grok 5/ }))
    fireEvent.click(screen.getByRole('button', { name: /Claude Opus 5\.5/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('never changes its own selection: the active model stays what the props say', () => {
    renderThemed(<ModelPicker models={models} onSelect={() => undefined} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: /GPT-6\.1 Sol/ }))
    expect(screen.getByRole('button', { name: /Claude Opus 5\.5/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /GPT-6\.1 Sol/ }).getAttribute('aria-current')).toBeNull()
  })

  it('works without onSelect', () => {
    renderThemed(<ModelPicker models={models} />, { locale: 'en' })
    expect(() => fireEvent.click(screen.getByRole('button', { name: /GPT-6\.1 Sol/ }))).not.toThrow()
  })

  it('shows the data note of every provider, and clamps a long one behind a show more button', () => {
    renderThemed(<ModelPicker models={models} />, { locale: 'en' })
    expect(screen.getByText(/handled under your Anthropic account terms/)).toBeTruthy()
    const gemini = screen.getByRole('group', { name: 'Google Gemini' })
    expect(within(gemini).getByRole('button', { name: 'Show more' })).toBeTruthy()
    expect(gemini.textContent).not.toContain('outside your own country')
    fireEvent.click(within(gemini).getByRole('button', { name: 'Show more' }))
    expect(gemini.textContent).toContain('outside your own country')
  })

  it('says it needs an engine restart without claiming a switch happened', () => {
    renderThemed(<ModelPicker models={models} />, { locale: 'en' })
    expect(screen.getByText(/may need an engine restart/)).toBeTruthy()
  })

  it('shows every provider as needing a key when nothing is configured, and no active model', () => {
    renderThemed(<ModelPicker models={modelsNothingConfigured} />, { locale: 'en' })
    expect(screen.getAllByText('Key needed')).toHaveLength(5)
    expect(screen.getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'true')).toHaveLength(0)
  })

  it('shows a message for an empty table', () => {
    renderThemed(<ModelPicker models={{ models: [], providers: [], active: null }} />, { locale: 'en' })
    expect(screen.getByText('There are no models to show.')).toBeTruthy()
  })

  it('renders names and notes from the engine as text', () => {
    const hostile = {
      ...models,
      providers: models.providers.map((provider, index) => (index === 0 ? { ...provider, label: '<img src=x onerror=alert(1)>' } : provider)),
      models: models.models.map((model, index) => (index === 0 ? { ...model, label: '<b>bold</b>‮', capabilities: { ...model.capabilities, dataNote: '<a href="https://evil.example">x</a>' } } : model)),
    }
    const { container } = renderThemed(<ModelPicker models={hostile} />, { locale: 'en' })
    expect(container.querySelector('img, a, b')).toBeNull()
    expect(container.textContent).toContain('<b>bold</b>‹U+202E›')
  })
})
