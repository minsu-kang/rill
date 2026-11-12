import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useT } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { ThemeProvider } from '../src/theme/ThemeProvider'

function Label() {
  const t = useT()
  return <span data-testid="label">{t('status.succeeded')}</span>
}

describe('ThemeProvider', () => {
  it('sets data-theme and lang on a wrapper element', () => {
    const { container } = render(
      <ThemeProvider theme="dark" locale="en">
        <Label />
      </ThemeProvider>,
    )
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.getAttribute('data-theme')).toBe('dark')
    expect(wrapper.getAttribute('lang')).toBe('en')
    expect(wrapper.contains(screen.getByTestId('label'))).toBe(true)
  })

  it('gives children the translator of its locale', () => {
    const { rerender } = render(
      <ThemeProvider theme="light" locale="ko">
        <Label />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('label').textContent).toBe(ko['status.succeeded'])
    rerender(
      <ThemeProvider theme="light" locale="en">
        <Label />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('label').textContent).toBe(en['status.succeeded'])
  })

  it('updates the attributes when the props change', () => {
    const { container, rerender } = render(
      <ThemeProvider theme="light" locale="ko">
        <Label />
      </ThemeProvider>,
    )
    rerender(
      <ThemeProvider theme="dark" locale="ko">
        <Label />
      </ThemeProvider>,
    )
    expect((container.firstElementChild as HTMLElement).getAttribute('data-theme')).toBe('dark')
  })

  it('uses Korean without a provider', () => {
    render(<Label />)
    expect(screen.getByTestId('label').textContent).toBe(ko['status.succeeded'])
  })
})
