import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS } from '@rill/protocol'

export type MemoryRule = 'empty' | 'control_character' | 'line_separator' | 'bidi_format' | 'format_character' | 'too_long'

const RULE_TEXT: Readonly<Record<MemoryRule, string>> = {
  empty: 'a note is not empty',
  control_character: 'a note is one line without control characters',
  line_separator: 'a note is one line without line or paragraph separators',
  bidi_format: 'a note has no bidirectional formatting characters',
  format_character: 'a note has no invisible format characters',
  too_long: `a note is at most ${MEMORY_MAX_CHARS} characters`,
}

export class MemoryInvalidError extends Error {
  readonly rule: MemoryRule
  readonly problems: string[]

  constructor(rule: MemoryRule) {
    super(`the note is not valid: ${rule}`)
    this.name = 'MemoryInvalidError'
    this.rule = rule
    this.problems = [`${rule}: ${RULE_TEXT[rule]}`]
  }
}

export class MemoryFullError extends Error {
  constructor() {
    super(`at most ${MEMORY_MAX_ITEMS} notes can be saved; delete one first`)
    this.name = 'MemoryFullError'
  }
}

export class MemoryDuplicateError extends Error {
  constructor() {
    super('a note with the same text is already saved')
    this.name = 'MemoryDuplicateError'
  }
}

const CONTROL = /\p{Cc}/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const FORMAT = /(?![\u200c\u200d])\p{Cf}|[\u{e0100}-\u{e01ef}]/u
const SPACES = /\s+/gu

export function normaliseMemoryText(raw: string): string {
  const trimmed = raw.normalize('NFC').trim()
  if (trimmed === '') throw new MemoryInvalidError('empty')
  if (CONTROL.test(trimmed)) throw new MemoryInvalidError('control_character')
  if (SEPARATOR.test(trimmed)) throw new MemoryInvalidError('line_separator')
  if (BIDI.test(trimmed)) throw new MemoryInvalidError('bidi_format')
  if (FORMAT.test(trimmed)) throw new MemoryInvalidError('format_character')
  const text = trimmed.replace(SPACES, ' ')
  if ([...text].length > MEMORY_MAX_CHARS) throw new MemoryInvalidError('too_long')
  return text
}

export function memoryKey(text: string): string {
  return text.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}
