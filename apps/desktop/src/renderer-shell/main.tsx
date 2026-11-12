import { RillClient } from '@rill/protocol'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Locale } from '../i18n'
import type { EngineInfo } from '../shared/host-api'
import { ThemeProvider, type Theme } from '../theme/ThemeProvider'
import { StatusPage } from './StatusPage'

const root = document.getElementById('root')
if (root === null) throw new Error('the page has no root element')

const locale: Locale = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en'
const theme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
const connect = (info: EngineInfo) => RillClient.connect(info.url, info.token)

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme} locale={locale}>
      <StatusPage host={window.rill} connect={connect} />
    </ThemeProvider>
  </StrictMode>,
)
