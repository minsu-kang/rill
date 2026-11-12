import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Locale } from '../src/i18n'
import { ThemeProvider, type Theme } from '../src/theme/ThemeProvider'

export function renderThemed(ui: ReactElement, options: { locale?: Locale; theme?: Theme } = {}): RenderResult {
  const { locale = 'ko', theme = 'light' } = options
  return render(
    <ThemeProvider theme={theme} locale={locale}>
      {ui}
    </ThemeProvider>,
  )
}
