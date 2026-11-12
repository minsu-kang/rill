import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../app/App'
import { watchCspViolations } from '../app/csp-watch'
import { HostProvider } from '../app/host'
import type { Locale } from '../i18n'
import { ThemeProvider, type Theme } from '../theme/ThemeProvider'

watchCspViolations()

const root = document.getElementById('root')
if (root === null) throw new Error('the page has no root element')

const locale: Locale = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en'
const theme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme} locale={locale}>
      <HostProvider host={window.rill}>
        <App />
      </HostProvider>
    </ThemeProvider>
  </StrictMode>,
)
