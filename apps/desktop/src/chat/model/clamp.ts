import { truncate } from '../../model/text'

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

export function hiddenLabel(char: string): string {
  return `‹U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}›`
}

export function markHidden(text: string, options: { keepLayout?: boolean } = {}): string {
  return text.replace(HIDDEN, (char) => (options.keepLayout === true && (char === '\n' || char === '\t') ? char : hiddenLabel(char)))
}

export function clampText(text: string, max: number): { shown: string; cut: boolean } {
  return text.length <= max ? { shown: text, cut: false } : { shown: truncate(text, max), cut: true }
}
