export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

export interface TextPart {
  text: string
  invisible: boolean
}

const INVISIBLE = /\p{Cf}/gu

export function invisibleLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

export function splitInvisible(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(INVISIBLE)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), invisible: false })
    parts.push({ text: match[0], invisible: true })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), invisible: false })
  return parts
}

export function escapeInvisible(text: string): string {
  return splitInvisible(text)
    .map((part) => (part.invisible ? `‹${invisibleLabel(part.text)}›` : part.text))
    .join('')
}
