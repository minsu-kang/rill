import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import preview from '../.storybook/preview'
import { useT } from '../src/i18n'
import { en } from '../src/i18n/en'

type Decorate = (story: () => ReactElement, context: { globals: Record<string, unknown> }) => ReactElement

function Label() {
  const t = useT()
  return <span data-testid="label">{t('status.failed')}</span>
}

function decorator(): Decorate {
  const first = [preview.decorators].flat()[0]
  if (typeof first !== 'function') throw new Error('the preview has no decorator')
  return first as unknown as Decorate
}

describe('storybook preview', () => {
  it('offers light and dark, Korean and English in the toolbar with Korean light as the start', () => {
    const globalTypes = preview.globalTypes as Record<string, { toolbar: { items: Array<{ value: string }> } }>
    expect(globalTypes.theme?.toolbar.items.map((item) => item.value)).toEqual(['light', 'dark'])
    expect(globalTypes.locale?.toolbar.items.map((item) => item.value)).toEqual(['ko', 'en'])
    expect(preview.initialGlobals).toEqual({ theme: 'light', locale: 'ko' })
  })

  it('wraps every story in ThemeProvider with the toolbar choices', () => {
    const { container } = render(decorator()(() => <Label />, { globals: { theme: 'dark', locale: 'en' } }))
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.getAttribute('data-theme')).toBe('dark')
    expect(wrapper.getAttribute('lang')).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe(en['status.failed'])
  })

  it('falls back to light and Korean for unknown toolbar values', () => {
    const { container } = render(decorator()(() => <Label />, { globals: { theme: 'neon', locale: 'xx' } }))
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.getAttribute('data-theme')).toBe('light')
    expect(wrapper.getAttribute('lang')).toBe('ko')
  })
})
