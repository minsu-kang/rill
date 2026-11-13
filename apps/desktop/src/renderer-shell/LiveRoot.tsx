import { useEffect, useMemo, useState } from 'react'
import type { ConnectFn } from '../app/connection'
import { isLanguage, type HostApi, type Language, type Settings } from '../shared/host-api'
import { ThemeProvider, type Theme } from '../theme/ThemeProvider'
import { localeFor } from './language'
import { Root } from './Root'

export interface LiveRootProps {
  host: HostApi | undefined
  connect?: ConnectFn
  theme: Theme
  systemLanguage: string
}

function observeLanguage(host: HostApi, report: (language: Language) => void): HostApi {
  let saved = 0
  const remember = (settings: Settings): Settings => {
    if (isLanguage(settings.language)) report(settings.language)
    return settings
  }
  return {
    ...host,
    settings: {
      get: async () => {
        const seen = saved
        const settings = await host.settings.get()
        if (saved === seen) remember(settings)
        return settings
      },
      update: async (patch) => {
        const settings = await host.settings.update(patch)
        saved += 1
        return remember(settings)
      },
    },
  }
}

export function LiveRoot({ host, connect, theme, systemLanguage }: LiveRootProps) {
  const [language, setLanguage] = useState<Language>('system')
  const locale = localeFor(language, systemLanguage)
  const observed = useMemo(() => (host === undefined ? undefined : observeLanguage(host, setLanguage)), [host])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    observed?.settings.get().catch(() => undefined)
  }, [observed])

  return (
    <ThemeProvider theme={theme} locale={locale}>
      <Root host={observed} connect={connect} />
    </ThemeProvider>
  )
}
