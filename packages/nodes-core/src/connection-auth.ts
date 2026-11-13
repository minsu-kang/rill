export type ConnectionAuth =
  | { type: 'none' }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; value: string }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }

export type ParsedConnectionSecret = { kind: 'plain' } | { kind: 'structured'; auth: ConnectionAuth } | { kind: 'malformed' }

export const AUTH_MAX_NAME = 128
export const AUTH_MAX_VALUE = 2000
export const AUTH_MAX_USERNAME = 256
export const AUTH_MAX_PASSWORD = 2000

const TOKEN_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const CONTROL = /\p{Cc}/u
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const LEADING_BLANK = /^\s+/
export const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'set-cookie',
  'upgrade',
  'keep-alive',
  'expect',
  'te',
  'trailer',
  'proxy-connection',
  'idempotency-key',
  'content-type',
])
const MIN_MASKED = 4
const MASK = '<secret>'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value)
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= AUTH_MAX_NAME && TOKEN_CHARS.test(value) && !FORBIDDEN_NAMES.has(value.toLowerCase())
}

function validText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !CONTROL.test(value) && !LONE_SURROGATE.test(value)
}

export function parseConnectionAuth(value: unknown): ConnectionAuth | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'none':
      return onlyKeys(value, ['type']) ? { type: 'none' } : undefined
    case 'apiKey':
      if (!onlyKeys(value, ['type', 'in', 'name', 'value'])) return undefined
      if ((value.in !== 'header' && value.in !== 'query') || !validName(value.name) || !validText(value.value, 1, AUTH_MAX_VALUE)) return undefined
      return { type: 'apiKey', in: value.in, name: value.name, value: value.value }
    case 'bearer':
      if (!onlyKeys(value, ['type', 'token']) || !validText(value.token, 1, AUTH_MAX_VALUE)) return undefined
      return { type: 'bearer', token: value.token }
    case 'basic':
      if (!onlyKeys(value, ['type', 'username', 'password'])) return undefined
      if (!validText(value.username, 1, AUTH_MAX_USERNAME) || value.username.includes(':') || !validText(value.password, 0, AUTH_MAX_PASSWORD)) return undefined
      return { type: 'basic', username: value.username, password: value.password }
    default:
      return undefined
  }
}

export function parseConnectionSecret(secret: string): ParsedConnectionSecret {
  const trimmed = secret.replace(LEADING_BLANK, '')
  if (!trimmed.startsWith('{')) return { kind: 'plain' }
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return { kind: 'plain' }
  }
  if (!isRecord(data) || !('rillAuth' in data)) return { kind: 'plain' }
  if (data.rillAuth !== 1) return { kind: 'malformed' }
  const rest: Record<string, unknown> = { ...data }
  delete rest.rillAuth
  const auth = parseConnectionAuth(rest)
  return auth === undefined ? { kind: 'malformed' } : { kind: 'structured', auth }
}

export function encodeConnectionSecret(auth: ConnectionAuth): string {
  return JSON.stringify({ rillAuth: 1, ...auth })
}

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const lower = name.toLowerCase()
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== lower))
}

function encodeQueryPart(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function decodeQueryName(pair: string): string {
  const raw = pair.split('=')[0]!.replaceAll('+', ' ')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function withQuery(url: string, name: string, value: string): string {
  const target = new URL(url)
  const kept = target.search.slice(1).split('&').filter((pair) => pair !== '' && decodeQueryName(pair) !== name)
  kept.push(`${encodeQueryPart(name)}=${encodeQueryPart(value)}`)
  target.search = `?${kept.join('&')}`
  return target.toString()
}

export function applyConnectionAuth(auth: ConnectionAuth, url: string, headers: Record<string, string>): { url: string; headers: Record<string, string> } {
  switch (auth.type) {
    case 'none':
      return { url, headers }
    case 'apiKey':
      return auth.in === 'header'
        ? { url, headers: { ...withoutHeader(headers, auth.name), [auth.name]: auth.value } }
        : { url: withQuery(url, auth.name, auth.value), headers }
    case 'bearer':
      return { url, headers: { ...withoutHeader(headers, 'Authorization'), Authorization: `Bearer ${auth.token}` } }
    case 'basic':
      return {
        url,
        headers: { ...withoutHeader(headers, 'Authorization'), Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}` },
      }
  }
}

export function secretParts(secret: string): string[] {
  const parsed = parseConnectionSecret(secret)
  if (parsed.kind !== 'structured') return []
  const { auth } = parsed
  switch (auth.type) {
    case 'none':
      return []
    case 'apiKey':
      return [auth.value]
    case 'bearer':
      return [auth.token]
    case 'basic': {
      const login = `${auth.username}:${auth.password}`
      return [...(auth.password === '' ? [] : [auth.password]), login, Buffer.from(login, 'utf8').toString('base64')]
    }
  }
}

function lowerHex(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase())
}

function echoForms(part: string): Set<string> {
  const forms = new Set([part, JSON.stringify(part).slice(1, -1)])
  for (const encoded of [encodeQueryPart(part), encodeURIComponent(part)]) {
    const plus = encoded.replaceAll('%20', '+')
    for (const form of [encoded, plus]) {
      forms.add(form)
      forms.add(lowerHex(form))
    }
  }
  return forms
}

export function maskSecretParts(text: string, parts: readonly string[]): string {
  let out = text
  for (const part of parts) {
    if (part.length < MIN_MASKED) continue
    for (const form of echoForms(part)) out = out.split(form).join(MASK)
  }
  return out
}
