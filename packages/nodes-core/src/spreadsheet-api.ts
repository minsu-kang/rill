import Type from 'typebox'
import Value from 'typebox/value'
import { accessTokenOf, renewedTokenOf, type AccountKind } from './account-connection'
import { maskSecretParts } from './connection-auth'
import { httpCall } from './http'
import { RetryableError, type ConnectionResolver } from './types'

export const SPREADSHEET_ID_PATTERN = '^[A-Za-z0-9_-]{20,100}$'
export const EXCEL_FILE_PATH_PATTERN = '^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?=.*[^/]\\.[xX][lL][sS][xX]$)[^\\p{C}\\\\:*?"<>|#%]{1,400}$'
export const EXCEL_TABLE_PATTERN = '^[\\p{L}_][\\p{L}\\p{N}_. -]{0,254}$'

export const ROW_MAX = 50
export const CELL_TEXT_MAX = 2000
export const UPDATED_RANGE_MAX = 200

const RESPONSE_MAX_BYTES = 65_536
const REQUEST_TIMEOUT_MS = 15_000
const HTTP_STATUS = /^HTTP (\d{3})\b/

const REASONS: Readonly<Record<number, string>> = {
  400: 'the data was not accepted',
  401: 'the sign-in is no longer valid, reconnect the account',
  403: 'the account may not change this file',
  404: 'the file, sheet or table was not found',
}

export const RowSchema = Type.Array(Type.Union([Type.String({ maxLength: CELL_TEXT_MAX }), Type.Number(), Type.Boolean(), Type.Null()]), { minItems: 1, maxItems: ROW_MAX })

export function encodePathPart(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function assertConfig(schema: Type.TSchema, config: unknown): void {
  const [first] = Value.Errors(schema, config)
  if (first !== undefined) throw new Error(`invalid config: ${first.instancePath === '' ? '/' : first.instancePath}: ${first.message}`)
}

class RefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RefusedError'
  }
}

function failure(error: unknown, tokens: readonly string[]): Error {
  if (!(error instanceof Error)) return new Error('the request failed')
  const message = maskSecretParts(error.message, tokens)
  if (error instanceof RetryableError) return new RetryableError(message)
  const status = HTTP_STATUS.exec(message)
  if (status === null) return new Error(message)
  const code = Number(status[1])
  if (code >= 400 && code < 500) return new RefusedError(`HTTP ${code}: ${REASONS[code] ?? 'the request was not accepted'}`, code)
  return new Error(message)
}

async function postRow(url: string, token: string, row: readonly unknown[], masked: readonly string[]): Promise<unknown> {
  try {
    const result = await httpCall(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: RESPONSE_MAX_BYTES,
      redact: (text) => maskSecretParts(text, masked),
    })
    return result.body
  } catch (error) {
    throw failure(error, masked)
  }
}

export interface PostedRow {
  body: unknown
  tokens: readonly string[]
}

export async function postRowRenewing(connections: ConnectionResolver, name: string, kind: AccountKind, url: string, row: readonly unknown[]): Promise<PostedRow> {
  const first = accessTokenOf(connections, name, kind)
  try {
    return { body: await postRow(url, first, row, [first]), tokens: [first] }
  } catch (error) {
    if (!(error instanceof RefusedError) || error.status !== 401) throw error
    const next = await renewedTokenOf(connections, name, first)
    if (next === undefined) throw error
    const tokens = [first, next]
    return { body: await postRow(url, next, row, tokens), tokens }
  }
}

export function untrustedText(value: unknown, tokens: readonly string[], max: number): string {
  if (typeof value !== 'string') return ''
  return maskSecretParts(value, tokens).replace(/\p{C}/gu, ' ').slice(0, max)
}
