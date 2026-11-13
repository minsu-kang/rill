import { domainToUnicode } from 'node:url'

export type LiteralKind = 'host' | 'path' | 'name'

export interface Literal {
  kind: LiteralKind
  text: string
  alternates?: string[]
  opaque?: boolean
}

const HOME = '\uE000home'

const BEFORE: Record<LiteralKind, RegExp> = {
  host: /[a-z0-9_.-]/,
  path: /[a-z0-9_.\uE000/-]/,
  name: /[a-z0-9_.@-]/,
}

const WORD = /[a-z0-9_@-]/

export function fold(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('~', HOME)
}

function stripTrailingSlashes(text: string): string {
  const stripped = text.replace(/\/+$/, '')
  return stripped === '' ? text : stripped
}

export function occursIn(haystack: string, needle: string, kind: LiteralKind): boolean {
  if (needle === '') return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? '' : haystack.charAt(at - 1)
    const after = haystack.charAt(at + needle.length)
    const next = haystack.charAt(at + needle.length + 1)
    const inPath = kind === 'host' && before === '/' && haystack.charAt(at - 2) !== '/'
    const touchesBefore = BEFORE[kind].test(before) || inPath
    const touchesAfter = WORD.test(after) || (after === '.' && WORD.test(next))
    if (!touchesBefore && !touchesAfter) return true
    from = at + 1
  }
}

export function occursInAny(haystacks: readonly string[], literal: Literal): boolean {
  const needles = [literal.text, ...(literal.alternates ?? [])]
  return haystacks.some((haystack) => needles.some((needle) => occursIn(haystack, needle, literal.kind)))
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const AUTHORITY_END = /[/\\?#]/

function authorityClosed(head: string): boolean {
  const scheme = SCHEME.exec(head)
  if (scheme === null) return false
  const rest = head.slice(scheme[0].length).replace(/^[/\\]*/, '')
  return AUTHORITY_END.test(rest)
}

function urlHost(head: string, templated: boolean): Literal {
  const opaque: Literal = { kind: 'name', text: fold(head.trim()), opaque: true }
  if (templated && !authorityClosed(head.trim())) return opaque
  let hostname: string
  try {
    hostname = new URL(head.trim()).hostname
  } catch {
    return opaque
  }
  const host = hostname.replace(/\.$/, '')
  if (host === '') return opaque
  const unicode = fold(domainToUnicode(host))
  return { kind: 'host', text: host, ...(unicode !== '' && unicode !== host ? { alternates: [unicode] } : {}) }
}

function literalHead(value: string): { head: string; templated: boolean } {
  const first = value.indexOf('{{')
  return first === -1 ? { head: value, templated: false } : { head: value.slice(0, first), templated: true }
}

export function literalOf(role: 'path' | 'url' | 'connection' | 'recipient', value: string): Literal | undefined {
  const { head, templated } = literalHead(value)
  if (role === 'url') return head.trim() === '' ? undefined : urlHost(head, templated)
  if (role === 'path') {
    const text = stripTrailingSlashes(fold(head.trim()))
    if (text === '' || (templated && text === HOME)) return undefined
    return { kind: 'path', text }
  }
  if (templated) return undefined
  const folded = fold(head.trim())
  const text = role === 'recipient' && folded.length > 1 && folded.startsWith('#') ? folded.slice(1) : folded
  if (text === '') return undefined
  return { kind: role === 'recipient' && /[./]/.test(text) ? 'path' : 'name', text }
}
