// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeyChecker, type KeyCheckFetch } from '../src/main/key-check'
import { PROVIDER_IDS, type KeyVerdict, type ProviderId } from '../src/shared/host-api'

const KEY = 'KEYCHECK-SECRET-MARKER-0123456789'
const BODY_MARKER = 'KEYCHECK-BODY-MARKER'
const FOUR_KIB = 4096

type Recorded = { url: string; init: Parameters<KeyCheckFetch>[1] }

function reply(status: number, body = ''): Response {
  return new Response(body.length === 0 ? null : body, { status })
}

function recorder(respond: (url: string) => Response | Promise<Response> = () => reply(200)) {
  const calls: Recorded[] = []
  const fetch: KeyCheckFetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url)
  }
  return { fetch, calls }
}

async function verdict(provider: ProviderId, status: number, body = ''): Promise<KeyVerdict> {
  const { fetch } = recorder(() => reply(status, body))
  return createKeyChecker({ fetch })(provider, KEY)
}

const REQUESTS: Record<ProviderId, { url: string; headers: Record<string, string> }> = {
  anthropic: { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'User-Agent': 'Rill' } },
  openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': 'Rill' } },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': KEY, 'User-Agent': 'Rill' } },
  grok: { url: 'https://api.x.ai/v1/models', headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': 'Rill' } },
  meta: { url: 'https://api.meta.ai/v1/models', headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': 'Rill' } },
}

const GEMINI_400 = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })
const GROK_400 = JSON.stringify({ code: 'Client specified an invalid argument', error: 'Incorrect API key provided: xai-****. You can obtain an API key from https://console.x.ai.' })
const GROK_400_OTHER = JSON.stringify({ error: 'Invalid API key' })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('key check: the request', () => {
  it.each(PROVIDER_IDS)('sends one GET with the fixed address and headers for %s, and the key only in its header', async (provider) => {
    const { fetch, calls } = recorder()
    expect(await createKeyChecker({ fetch })(provider, KEY)).toEqual({ status: 'valid' })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe(REQUESTS[provider].url)
    expect(url).not.toContain(KEY)
    expect(url).not.toContain('?')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual(REQUESTS[provider].headers)
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect('body' in init).toBe(false)
    const outside = JSON.stringify({ url, method: init.method, redirect: init.redirect, credentials: init.credentials })
    expect(outside).not.toContain(KEY)
    expect(Object.keys(init).sort()).toEqual(['credentials', 'headers', 'method', 'redirect', 'signal'])
  })

  it('has an address for every provider and no other', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual([...PROVIDER_IDS].sort())
  })

  it('sends nothing for a key that cannot be a header value, and says so', async () => {
    for (const bad of ['sk ant', 'sk\nant', 'sk-ant-…', 'sk\u0000ant', 'sk\tant', 'sk-ä']) {
      const { fetch, calls } = recorder()
      expect(await createKeyChecker({ fetch })('anthropic', bad)).toEqual({ status: 'invalid', reason: 'malformed' })
      expect(calls).toHaveLength(0)
    }
  })

  it('keeps concurrent calls independent', async () => {
    const answers: Record<string, number> = {
      'https://api.anthropic.com/v1/models': 401,
      'https://api.openai.com/v1/models': 200,
      'https://generativelanguage.googleapis.com/v1beta/models': 429,
      'https://api.x.ai/v1/models': 503,
      'https://api.meta.ai/v1/models': 403,
    }
    const { fetch, calls } = recorder((url) => reply(answers[url]!))
    const check = createKeyChecker({ fetch })
    const results = await Promise.all(PROVIDER_IDS.map((provider, index) => check(provider, `${KEY}-${index}`)))
    expect(results).toEqual([
      { status: 'invalid', reason: 'unauthorized' },
      { status: 'valid' },
      { status: 'unverified', reason: 'rate_limited' },
      { status: 'unverified', reason: 'server_error' },
      { status: 'unverified', reason: 'forbidden' },
    ])
    expect(calls).toHaveLength(5)
    expect(new Set(calls.map((call) => call.url)).size).toBe(5)
  })

  it('does not share anything between calls of the same checker', async () => {
    const { fetch, calls } = recorder()
    const check = createKeyChecker({ fetch })
    await check('openai', `${KEY}-one`)
    await check('openai', `${KEY}-two`)
    expect(calls.map((call) => call.init.headers['Authorization'])).toEqual([`Bearer ${KEY}-one`, `Bearer ${KEY}-two`])
  })
})

describe('key check: classification', () => {
  it.each(PROVIDER_IDS)('%s: any 2xx is valid', async (provider) => {
    for (const status of [200, 201, 204]) expect(await verdict(provider, status)).toEqual({ status: 'valid' })
  })

  it.each(PROVIDER_IDS)('%s: 401 is invalid as unauthorized', async (provider) => {
    expect(await verdict(provider, 401)).toEqual({ status: 'invalid', reason: 'unauthorized' })
  })

  it.each(PROVIDER_IDS)('%s: 403 is unverified as forbidden, never invalid', async (provider) => {
    expect(await verdict(provider, 403)).toEqual({ status: 'unverified', reason: 'forbidden' })
  })

  it.each(PROVIDER_IDS)('%s: 429 is rate_limited and 5xx is server_error', async (provider) => {
    expect(await verdict(provider, 429)).toEqual({ status: 'unverified', reason: 'rate_limited' })
    for (const status of [500, 502, 503, 529, 599]) expect(await verdict(provider, status)).toEqual({ status: 'unverified', reason: 'server_error' })
  })

  it.each(PROVIDER_IDS)('%s: every other status is unexpected_status', async (provider) => {
    for (const status of [300, 301, 302, 304, 404, 405, 408, 418, 422]) {
      expect(await verdict(provider, status), String(status)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    }
  })

  it('gemini: 400 with API_KEY_INVALID is invalid, any other 400 is unverified', async () => {
    expect(await verdict('gemini', 400, GEMINI_400)).toEqual({ status: 'invalid', reason: 'rejected' })
    expect(await verdict('gemini', 400, '{"error":{"message":"Bad request"}}')).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(await verdict('gemini', 400)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(await verdict('gemini', 400, GROK_400)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
  })

  it('grok: 400 with the wording about an incorrect or invalid key is invalid, any other 400 is unverified', async () => {
    expect(await verdict('grok', 400, GROK_400)).toEqual({ status: 'invalid', reason: 'rejected' })
    expect(await verdict('grok', 400, GROK_400_OTHER)).toEqual({ status: 'invalid', reason: 'rejected' })
    expect(await verdict('grok', 400, '{"error":"INCORRECT API KEY"}')).toEqual({ status: 'invalid', reason: 'rejected' })
    expect(await verdict('grok', 400, '{"error":"bad request"}')).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(await verdict('grok', 400)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(await verdict('grok', 400, GEMINI_400)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
  })

  it.each(['anthropic', 'openai', 'meta'] as const)('%s: a 400 is unverified whatever the body says', async (provider) => {
    expect(await verdict(provider, 400, GEMINI_400)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(await verdict(provider, 400, GROK_400)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
  })

  it('classifies a redirect that fetch refuses, a network error and a body failure as unverified', async () => {
    const refuse = (error: unknown): KeyCheckFetch => async () => {
      throw error
    }
    for (const error of [new TypeError('fetch failed'), new Error('ECONNREFUSED'), 'text', undefined]) {
      expect(await createKeyChecker({ fetch: refuse(error) })('anthropic', KEY)).toEqual({ status: 'unverified', reason: 'network' })
    }
    const broken: KeyCheckFetch = async () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error('reset')) }), { status: 400 })
    expect(await createKeyChecker({ fetch: broken })('gemini', KEY)).toEqual({ status: 'unverified', reason: 'network' })
  })
})

describe('key check: timeout', () => {
  function hang(): KeyCheckFetch {
    return (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
  }

  it('gives up after 10 seconds and says timeout', async () => {
    vi.useFakeTimers()
    const result = createKeyChecker({ fetch: hang() })('openai', KEY)
    await vi.advanceTimersByTimeAsync(9_999)
    let settled = false
    void result.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ status: 'unverified', reason: 'timeout' })
  })

  it('also covers a body that never ends', async () => {
    vi.useFakeTimers()
    const slow: KeyCheckFetch = async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(stream, { status: 400 })
    }
    const result = createKeyChecker({ fetch: slow })('gemini', KEY)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toEqual({ status: 'unverified', reason: 'timeout' })
  })

  it('stops the timer once the answer is there', async () => {
    vi.useFakeTimers()
    const { fetch } = recorder()
    expect(await createKeyChecker({ fetch })('openai', KEY)).toEqual({ status: 'valid' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the timeout it is given', async () => {
    vi.useFakeTimers()
    const result = createKeyChecker({ fetch: hang(), timeoutMs: 50 })('openai', KEY)
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toEqual({ status: 'unverified', reason: 'timeout' })
  })
})

describe('key check: the response body', () => {
  function streamed(filler: number, tail: string) {
    const encoder = new TextEncoder()
    const state = { pulled: 0, cancelled: false }
    const chunk = encoder.encode('x'.repeat(1024))
    let left = filler
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (left > 0) {
          const part = chunk.subarray(0, Math.min(chunk.byteLength, left))
          left -= part.byteLength
          state.pulled += part.byteLength
          controller.enqueue(part)
          return
        }
        const rest = encoder.encode(tail)
        state.pulled += rest.byteLength
        controller.enqueue(rest)
        controller.close()
      },
      cancel() {
        state.cancelled = true
      },
    })
    return { response: new Response(stream, { status: 400 }), state }
  }

  it('reads at most 4 KiB, so wording after that is not seen', async () => {
    const { response, state } = streamed(FOUR_KIB + 2048, 'API_KEY_INVALID')
    const fetch: KeyCheckFetch = async () => response
    expect(await createKeyChecker({ fetch })('gemini', KEY)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeLessThanOrEqual(FOUR_KIB + 1024)
  })

  it('still sees wording inside the first 4 KiB', async () => {
    const { response } = streamed(2048, 'API_KEY_INVALID')
    const fetch: KeyCheckFetch = async () => response
    expect(await createKeyChecker({ fetch })('gemini', KEY)).toEqual({ status: 'invalid', reason: 'rejected' })
  })

  it('reads nothing for any status but 400, and cancels the body', async () => {
    for (const status of [200, 401, 403, 429, 500]) {
      const { response, state } = streamed(FOUR_KIB * 4, BODY_MARKER)
      const fetch: KeyCheckFetch = async () => new Response(response.body, { status })
      await createKeyChecker({ fetch })('gemini', KEY)
      expect(state.cancelled, String(status)).toBe(true)
      expect(state.pulled, String(status)).toBeLessThanOrEqual(1024)
    }
  })

  it('handles a response without a body', async () => {
    const fetch: KeyCheckFetch = async () => reply(400)
    expect(await createKeyChecker({ fetch })('grok', KEY)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
  })
})

describe('key check: nothing leaks', () => {
  it('puts neither the key nor the body into any verdict, and logs nothing', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'debug')]
    const stderr = vi.spyOn(process.stderr, 'write')
    const stdout = vi.spyOn(process.stdout, 'write')
    const results: unknown[] = []
    for (const provider of PROVIDER_IDS) {
      for (const status of [200, 400, 401, 403, 429, 500, 404]) {
        results.push(await verdict(provider, status, `${GEMINI_400} ${GROK_400} ${BODY_MARKER} ${KEY}`))
      }
      for (const error of [new Error(`boom ${KEY} ${BODY_MARKER}`), `${KEY}`]) {
        const fail: KeyCheckFetch = async () => {
          throw error
        }
        results.push(await createKeyChecker({ fetch: fail })(provider, KEY))
      }
    }
    const text = JSON.stringify(results)
    expect(text).not.toContain('KEYCHECK')
    expect(text).not.toContain(KEY)
    for (const result of results) expect(Object.keys(result as object).sort()).toEqual(expect.arrayContaining(['status']))
    for (const spy of [...spies, stderr, stdout]) expect(spy).not.toHaveBeenCalled()
  })

  it('never rejects: even a fetch that throws synchronously or an invalid response becomes unverified', async () => {
    const sync: KeyCheckFetch = () => {
      throw new Error(KEY)
    }
    expect(await createKeyChecker({ fetch: sync })('openai', KEY)).toEqual({ status: 'unverified', reason: 'network' })
    const odd: KeyCheckFetch = async () => ({ status: 'ok' }) as never
    const result = await createKeyChecker({ fetch: odd })('openai', KEY)
    expect(result.status).toBe('unverified')
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})
