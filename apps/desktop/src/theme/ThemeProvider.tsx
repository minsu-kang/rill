import type { ReactNode } from 'react'
import { LocaleContext, type Locale } from '../i18n'
import styles from './ThemeProvider.module.css'
import './tokens.css'

export type Theme = 'light' | 'dark'

export interface ThemeProviderProps {
  theme: Theme
  locale: Locale
  children: ReactNode
}

export function ThemeProvider({ theme, locale, children }: ThemeProviderProps) {
  return (
    <LocaleContext.Provider value={locale}>
      <div className={styles.root} data-theme={theme} lang={locale}>
        {children}
      </div>
    </LocaleContext.Provider>
  )
}
