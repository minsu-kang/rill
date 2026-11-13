import type { Locale } from '../i18n'
import type { Language } from '../shared/host-api'

export function localeFor(language: Language, systemLanguage: string | undefined): Locale {
  if (language !== 'system') return language
  return (systemLanguage ?? '').toLowerCase().split(/[-_]/)[0] === 'ko' ? 'ko' : 'en'
}
