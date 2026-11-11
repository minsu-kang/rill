export type LiteralKind = 'host' | 'path' | 'name'

export interface Literal {
  kind: LiteralKind
  text: string
}

const HOME = 'home'

const BEFORE: Record<LiteralKind, RegExp> = {
  host: /[a-z0-9_.-]/,
  path: /[a-z0-9_./-]/,
  name: /[a-z0-9_.@-]/,
}

const WORD = /[a-z0-9_@-]/

export function fold(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(/~(?=\/|$)/g, HOME)
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
    const touchesBefore = BEFORE[kind].test(before)
    const touchesAfter = WORD.test(after) || (after === '.' && WORD.test(next))
    if (!touchesBefore && !touchesAfter) return true
    from = at + 1
  }
}

export function occursInAny(haystacks: readonly string[], literal: Literal): boolean {
  return haystacks.some((haystack) => occursIn(haystack, literal.text, literal.kind))
}

function literalHost(value: string): string | undefined {
  const first = value.indexOf('{{')
  const head = first === -1 ? value : value.slice(0, first)
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]*)([/?#:]|$)/i.exec(head)
  if (match === null) return undefined
  if (match[2] === '' && first !== -1) return undefined
  const host = (match[1] as string).toLowerCase().replace(/\.$/, '')
  return host === '' ? undefined : host
}

function literalHead(value: string): { head: string; templated: boolean } {
  const first = value.indexOf('{{')
  return first === -1 ? { head: value, templated: false } : { head: value.slice(0, first), templated: true }
}

export function literalOf(role: 'path' | 'url' | 'connection' | 'recipient', value: string): Literal | undefined {
  if (role === 'url') {
    const host = literalHost(value)
    if (host !== undefined) return { kind: 'host', text: host }
  }
  const { head, templated } = literalHead(value)
  if (role === 'path') {
    const text = stripTrailingSlashes(fold(head.trim()))
    if (text === '' || (templated && text === HOME)) return undefined
    return { kind: 'path', text }
  }
  if (templated) return undefined
  const text = fold(head.trim())
  return text === '' ? undefined : { kind: 'name', text }
}
