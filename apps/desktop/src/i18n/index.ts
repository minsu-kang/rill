import { createContext, useContext, useMemo } from 'react'
import { en } from './en'
import { ko } from './ko'

export type Locale = 'ko' | 'en'
export type DictionaryKey = keyof typeof ko
export type MessageKey = DictionaryKey extends infer Key ? (Key extends `${infer Base}.${'one' | 'other'}` ? Base : Key) : never
export type TranslateVars = Record<string, string | number>
export type Translate = (key: MessageKey, vars?: TranslateVars) => string

const DICTIONARIES: Record<Locale, Readonly<Record<DictionaryKey, string>>> = { ko, en }
const LANGUAGE_TAGS: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US' }
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

export function createTranslator(locale: Locale): Translate {
  const dictionary = DICTIONARIES[locale]
  const plurals = new Intl.PluralRules(LANGUAGE_TAGS[locale])
  const numbers = new Intl.NumberFormat(LANGUAGE_TAGS[locale])
  const has = (name: string): name is DictionaryKey => Object.hasOwn(dictionary, name)
  return (key, vars) => {
    const count = vars?.count
    const form = typeof count === 'number' ? `${key}.${plurals.select(count)}` : undefined
    const name = form !== undefined && has(form) ? form : has(key) ? key : `${key}.other`
    if (!has(name)) return key
    const template = dictionary[name]
    if (vars === undefined) return template
    return template.replace(PLACEHOLDER, (whole, variable: string) => {
      if (!Object.hasOwn(vars, variable)) return whole
      const value = vars[variable]!
      return typeof value === 'number' ? numbers.format(value) : String(value)
    })
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
