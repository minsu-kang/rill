import type { Locale } from '../../i18n'

export function localeTag(locale: Locale): string {
  return locale === 'ko' ? 'ko-KR' : 'en-US'
}

export function formatBytes(bytes: number, locale: Locale): string {
  const numbers = new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 })
  if (bytes < 1024) return `${numbers.format(bytes)} B`
  if (bytes < 1024 * 1024) return `${numbers.format(bytes / 1024)} KB`
  return `${numbers.format(bytes / (1024 * 1024))} MB`
}

export function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 }).format(value)
}

export function formatSeconds(ms: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(ms / 1000)
}
