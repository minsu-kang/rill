import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { watchCspViolations } from '../app/csp-watch'
import type { Locale } from '../i18n'
import { ThemeProvider, type Theme } from '../theme/ThemeProvider'
import { Root } from './Root'

watchCspViolations()

const root = document.getElementById('root')
if (root === null) throw new Error('the page has no root element')

const locale: Locale = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en'
const theme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme} locale={locale}>
      <Root host={window.rill} />
    </ThemeProvider>
  </StrictMode>,
)
