import { RetryableError } from './types'

export interface HttpCallInit {
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  signal?: AbortSignal
  maxBytes?: number
  redact?: (text: string) => string
}

export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: unknown
}

const DEFAULT_MAX_BYTES = 5_242_880

class ResponseTooLargeError extends Error {}

function parseBody(text: string, contentType: string | undefined): unknown {
  if (contentType?.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function failureCode(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.name : 'unknown'
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new ResponseTooLargeError()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function httpCall(url: string, init: HttpCallInit): Promise<HttpResult> {
  let target: URL
  let headers: Headers
  try {
    target = new URL(url)
    headers = new Headers(init.headers)
  } catch {
    throw new Error('invalid request: the URL or a header is malformed')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${target.protocol}`)
  }
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES
  let status: number
  let responseHeaders: Record<string, string>
  let text: string
  try {
    const response = await fetch(target, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'manual',
      signal: init.signal === undefined ? AbortSignal.timeout(init.timeoutMs) : AbortSignal.any([AbortSignal.timeout(init.timeoutMs), init.signal]),
    })
    status = response.status
    responseHeaders = Object.fromEntries(response.headers.entries())
    text = await readLimited(response, maxBytes)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`response is larger than ${maxBytes} bytes`, { cause: error })
    }
    throw new RetryableError(`network error: ${failureCode(error)}`, { cause: error })
  }
  if (status >= 300 && status < 400) throw new Error(`HTTP ${status}: redirects are not followed`)
  if (status === 429 || status >= 500) throw new RetryableError(`HTTP ${status}`)
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${(init.redact?.(text) ?? text).slice(0, 200)}`)
  return { status, headers: responseHeaders, body: parseBody(text, responseHeaders['content-type']) }
}
