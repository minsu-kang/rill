export const MAX_DEPTH = 4
export const MAX_ITEMS = 5
export const MAX_KEYS = 20
export const MAX_STRING = 200

const MAX_KEY = 100
const WINDOW = 1_048_576
const MIN_SECRET = 4
const MARKER_ROOM = 30
const WORK_BUDGET = 6000
const SECRET_MARK = '<secret>'
const REDACTED = '<redacted>'

const AUTH_KEY = /authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|x-api-key|bearer|session|credential/i
const AUTH_QUERY = /token|secret|password|passwd|key|sig|signature|auth|credential|session/i
const QUERY_PARAM = /([?&;])([^=&#\s]{1,64})=([^&#\s]*)/g
const USER_INFO = /(:\/\/)[^/\s@]+@/g
const BASE64 = /^[A-Za-z0-9+/_-]{200,}={0,2}$/
const DATA_URL = /^data:[^,\s]{0,100},/i
const REQUEST_HEADERS: ReadonlySet<string> = new Set(['content-type', 'accept', 'idempotency-key'])
const RESPONSE_HEADERS: ReadonlySet<string> = new Set(['content-type', 'retry-after'])

export interface Redactor {
  string(text: string): string
  seal(text: string): string
  cut(text: string, limit: number, more?: number): string
  within(text: string, limit: number): string
}

function variantsOf(secret: string): string[] {
  return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret, 'utf8').toString('base64')]
}

function needlesOf(secrets: readonly string[]): string[] {
  const found = new Set<string>()
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET) continue
    for (const form of variantsOf(secret)) if (form.length >= MIN_SECRET) found.add(form)
  }
  return [...found].sort((a, b) => b.length - a.length)
}

function replaceIn(part: string, needles: readonly string[]): string {
  let out = part
  for (const needle of needles) if (out.includes(needle)) out = out.split(needle).join(SECRET_MARK)
  return out
}

function sanitiseUrls(text: string): string {
  let out = text
  if (out.includes('://')) out = out.replace(USER_INFO, `$1${REDACTED}@`)
  if (out.includes('=') && /[?&;]/.test(out)) {
    out = out.replace(QUERY_PARAM, (whole, separator: string, name: string) => (AUTH_QUERY.test(name) ? `${separator}${name}=${REDACTED}` : whole))
  }
  return out
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const needles = needlesOf(secrets)
  const seal = (text: string): string => (needles.length === 0 ? text : text.split(SECRET_MARK).map((part) => replaceIn(part, needles)).join(SECRET_MARK))
  const cut = (text: string, limit: number, more = 0): string =>
    text.length <= limit ? text : `${text.slice(0, limit)}… ${text.length - limit + more} more characters`
  return {
    string: (text) => sanitiseUrls(seal(text.length > WINDOW ? text.slice(0, WINDOW) : text)),
    seal,
    cut,
    within: (text, limit) => (text.length <= limit ? text : cut(text, Math.max(0, limit - MARKER_ROOM))),
  }
}

export interface ExcerptOptions {
  responseHeaders?: boolean
}

interface Context {
  redactor: Redactor
  options: ExcerptOptions
  budget: number
}

function overflow(original: string): number {
  return Math.max(0, original.length - WINDOW)
}

function leaf(text: string, ctx: Context): string {
  const processed = ctx.redactor.string(text)
  ctx.budget -= Math.min(processed.length, MAX_STRING) + 4
  if (BASE64.test(processed) || DATA_URL.test(processed)) return `<binary ${text.length} chars>`
  return ctx.redactor.cut(processed, MAX_STRING, overflow(text))
}

function keyText(key: string, ctx: Context): string {
  const head = key.length > MAX_KEY ? `${key.slice(0, MAX_KEY)}…` : key
  ctx.budget -= head.length + 4
  return ctx.redactor.string(head)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function headersOf(value: unknown, ctx: Context, response: boolean): unknown {
  if (!isRecord(value)) return REDACTED
  const allowed = response ? RESPONSE_HEADERS : REQUEST_HEADERS
  const out: Record<string, unknown> = {}
  const names = Object.keys(value)
  let dropped = 0
  let shown = 0
  for (const name of names) {
    const kept = allowed.has(name.toLowerCase())
    if (response && !kept) {
      dropped += 1
      continue
    }
    if (shown >= MAX_KEYS) {
      dropped += 1
      continue
    }
    shown += 1
    const entry = value[name]
    out[keyText(name, ctx)] = kept && typeof entry === 'string' ? leaf(entry, ctx) : REDACTED
  }
  if (dropped > 0) out['…'] = response ? `${dropped} more headers dropped` : `${dropped} more keys`
  return out
}

function prune(value: unknown, ctx: Context, depth: number): unknown {
  if (typeof value === 'string') return leaf(value, ctx)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `<array ${value.length} items>`
    const items: unknown[] = []
    for (const item of value.slice(0, MAX_ITEMS)) {
      if (ctx.budget <= 0) break
      items.push(prune(item, ctx, depth + 1))
    }
    if (value.length > items.length) items.push(`… ${value.length - items.length} more`)
    return items
  }
  if (isRecord(value)) {
    const names = Object.keys(value)
    if (depth >= MAX_DEPTH) return `<object ${names.length} keys>`
    const out: Record<string, unknown> = {}
    let shown = 0
    for (const name of names.slice(0, MAX_KEYS)) {
      if (ctx.budget <= 0) break
      shown += 1
      const entry = value[name]
      const response = depth === 0 && ctx.options.responseHeaders === true
      let pruned: unknown
      if (AUTH_KEY.test(name.length > 200 ? name.slice(0, 200) : name)) pruned = REDACTED
      else if (name.toLowerCase() === 'headers') pruned = headersOf(entry, ctx, response)
      else pruned = prune(entry, ctx, depth + 1)
      out[keyText(name, ctx)] = pruned
    }
    if (names.length > shown) out['…'] = `${names.length - shown} more keys`
    return out
  }
  return typeof value === 'undefined' ? null : String(value)
}

export function excerpt(value: unknown, redactor: Redactor, options: ExcerptOptions = {}): string {
  const ctx: Context = { redactor, options, budget: WORK_BUDGET }
  return JSON.stringify(prune(value, ctx, 0)) ?? 'null'
}

const LINE_BREAKS = String.fromCharCode(0x2028, 0x2029)
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f${LINE_BREAKS}]+`, 'g')

export function oneLine(text: string): string {
  return text.replace(CONTROL, ' ')
}
