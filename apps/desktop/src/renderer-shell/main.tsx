import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { watchCspViolations } from '../app/csp-watch'
import './global.css'
import type { Theme } from '../theme/ThemeProvider'
import { LiveRoot } from './LiveRoot'

watchCspViolations()

const root = document.getElementById('root')
if (root === null) throw new Error('the page has no root element')

const theme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(root).render(
  <StrictMode>
    <LiveRoot host={window.rill} theme={theme} systemLanguage={navigator.language} />
  </StrictMode>,
)
