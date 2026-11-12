import { domainToASCII } from 'node:url'

const SEPARATORS = /[\s"'`<>()[\]{},;|]+/
const IDNA_DOTS = /[\u3002\uff0e\uff61]/g
const INVISIBLE = /[\p{Cf}\p{Cc}]/gu
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const PORT = /:\d{1,5}$/
const EDGE_MARKS = /^[.:!?]+|[.:!?]+$/g
const TLD = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/
const FILE_LIKE = /^(?:csv|tsv|txt|json|xml|ya?ml|pdf|png|jpe?g|gif|svg|xlsx?|docx?|pptx?|log|dat|html?)$/

function hostOf(raw: string): string | undefined {
  const token = raw.normalize('NFKC').replace(IDNA_DOTS, '.').replace(INVISIBLE, '').replace(EDGE_MARKS, '')
  const authority = (token.replace(SCHEME, '').split(/[/?#]/, 1)[0] ?? '').replace(/^.*@/, '').replace(PORT, '')
  if (!authority.includes('.')) return undefined
  const ascii = domainToASCII(authority.toLowerCase())
  const labels = ascii.split('.')
  const last = labels[labels.length - 1] ?? ''
  if (ascii === '' || labels.some((label) => label === '') || !TLD.test(last) || FILE_LIKE.test(last)) return undefined
  return ascii
}

export function hostsIn(text: string): string[] {
  const found = new Set<string>()
  for (const raw of text.split(SEPARATORS)) {
    const host = hostOf(raw)
    if (host !== undefined) found.add(host)
  }
  return [...found]
}

export function foreignHosts(text: string, known: string): string[] {
  const own = new Set(hostsIn(known))
  return hostsIn(text).filter((host) => !own.has(host))
}
