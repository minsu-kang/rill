import { createContext, useContext, useMemo } from 'react'
import { en } from './en'
import { ko } from './ko'

export type Locale = 'ko' | 'en'
export type MessageKey = keyof typeof ko
export type TranslateVars = Record<string, string | number>
export type Translate = (key: MessageKey, vars?: TranslateVars) => string

const DICTIONARIES: Record<Locale, Readonly<Record<MessageKey, string>>> = { ko, en }
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

export function createTranslator(locale: Locale): Translate {
  const dictionary = DICTIONARIES[locale]
  return (key, vars) => {
    if (!Object.hasOwn(dictionary, key)) return key
    const template = dictionary[key]
    if (vars === undefined) return template
    return template.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole))
  }
}

export const LocaleContext = createContext<Locale>('ko')

export function useLocale(): Locale {
  return useContext(LocaleContext)
}

export function useT(): Translate {
  const locale = useLocale()
  return useMemo(() => createTranslator(locale), [locale])
}
