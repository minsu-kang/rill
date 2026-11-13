import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetryableError, SLACK_POST_URL, encodeSlackBotSecret, postSlackMessage, type SlackFailure, type SlackPostResult } from '../src/index'

const BOT_TOKEN = 'xoxb-POSTTOKENMARKER0123'
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/POSTWEBHOOKMARKER'

interface Call {
  url: string
  method: string
  headers: Headers
  body: string
  redirect: string | undefined
  signal: AbortSignal | undefined
}

function stub(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    return respond(call)
  })
  return calls
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
const bot = (channel?: string) => encodeSlackBotSecret({ token: BOT_TOKEN, ...(channel === undefined ? {} : { channel }) })
const post = (secret: string, extra: { channel?: string; timeoutMs?: number; signal?: AbortSignal } = {}) =>
  postSlackMessage({ secret, text: 'Workflow "w" failed.', timeoutMs: 15_000, ...extra })

function failed(result: SlackPostResult): { failure: SlackFailure; error: Error } {
  if (result.ok) throw new Error('expected a failure')
  return result
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postSlackMessage with a bot token', () => {
  it('posts chat.postMessage with the token in the header, the channel and the text, and no redirect', async () => {
    const calls = stub(() => json({ ok: true, ts: '1.2' }))
    expect(await post(bot('#default'), { channel: '#alerts' })).toEqual({ ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(SLACK_POST_URL).toBe('https://slack.com/api/chat.postMessage')
    expect(call.url).toBe(SLACK_POST_URL)
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Bearer ${BOT_TOKEN}`)
    expect(call.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(call.redirect).toBe('manual')
    expect(JSON.parse(call.body)).toEqual({ channel: '#alerts', text: 'Workflow "w" failed.' })
    expect(call.body).not.toContain(BOT_TOKEN)
  })

  it('prefers the channel that is given over the default channel of the connection, and falls back to the default', async () => {
    const calls = stub(() => json({ ok: true }))
    await post(bot('C0123ABCDEF'))
    await post(bot('C0123ABCDEF'), { channel: '#override' })
    await post(BOT_TOKEN, { channel: '#plain-token' })
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['C0123ABCDEF', '#override', '#plain-token'])
  })

  it('gives a connection failure and sends nothing when no channel is known', async () => {
    const calls = stub(() => json({ ok: true }))
    for (const secret of [bot(), BOT_TOKEN]) {
      const result = failed(await post(secret))
      expect(result.failure).toBe('connection')
      expect(result.error.message).toBe('no Slack channel: set the channel of this step or give the connection a default channel')
      expect(result.error).not.toBeInstanceOf(RetryableError)
    }
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['channel_not_found', 'Slack: channel_not_found', false],
    ['invalid_auth', 'Slack: invalid_auth', false],
    ['Bad Code!', 'Slack: unknown_error', false],
    ['ratelimited', 'Slack: ratelimited', true],
    ['request_timeout', 'Slack: request_timeout', true],
  ])('gives a Slack failure for the answer ok false with %j, with the node message and its retry kind', async (code, message, retryable) => {
    stub(() => json({ ok: false, error: code }))
    const result = failed(await post(bot('#a')))
    expect(result.failure).toBe('slack_error')
    expect(result.error.message).toBe(message)
    expect(result.error instanceof RetryableError).toBe(retryable)
  })

  it.each([
    ['plain text', () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })],
    ['json without ok', () => json({ result: 'fine' })],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('treats %s as a Slack failure with the fixed message', async (_label, respond) => {
    stub(respond)
    const result = failed(await post(bot('#a')))
    expect(result.failure).toBe('slack_error')
    expect(result.error.message).toBe('Slack: unexpected_response')
  })

  it.each([
    [400, false],
    [403, false],
    [404, false],
    [429, true],
    [500, true],
    [503, true],
  ])('gives an HTTP status failure for %i', async (status, retryable) => {
    stub(() => new Response('nope', { status }))
    const result = failed(await post(bot('#a')))
    expect(result.failure).toBe('http_status')
    expect(result.error.message).toMatch(new RegExp(`^HTTP ${status}`))
    expect(result.error instanceof RetryableError).toBe(retryable)
  })

  it('gives an HTTP status failure for a redirect and refuses to follow it', async () => {
    stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }))
    const result = failed(await post(bot('#a')))
    expect(result.failure).toBe('http_status')
    expect(result.error.message).toBe('HTTP 302: redirects are not followed')
  })

  it('masks a token that a 4xx body echoes', async () => {
    stub(() => new Response(`token ${BOT_TOKEN} is not allowed`, { status: 400 }))
    const result = failed(await post(bot('#a')))
    expect(result.error.message).toBe('HTTP 400: token <secret> is not allowed')
  })

  it('gives a timeout failure when the time runs out, and keeps the retryable error of the node', async () => {
    stub((call) => new Promise<Response>((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(call.signal?.reason))))
    const result = failed(await post(bot('#a'), { timeoutMs: 20 }))
    expect(result.failure).toBe('timeout')
    expect(result.error).toBeInstanceOf(RetryableError)
    expect(result.error.message).toBe('network error: TimeoutError')
  })

  it('gives a timeout failure for a TimeoutError that the fetch raises by itself', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    expect(failed(await post(bot('#a'))).failure).toBe('timeout')
  })

  it('gives an unknown failure for another network error, without the token in the message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`fetch failed for ${BOT_TOKEN}`, { cause: Object.assign(new Error(BOT_TOKEN), { code: 'ECONNRESET' }) })
    })
    const result = failed(await post(bot('#a')))
    expect(result.failure).toBe('unknown')
    expect(result.error).toBeInstanceOf(RetryableError)
    expect(result.error.message).toBe('network error: ECONNRESET')
  })

  it('gives an unknown failure when the caller aborts, also when the abort came first', async () => {
    const controller = new AbortController()
    stub((call) => new Promise<Response>((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(call.signal?.reason))))
    const pending = post(bot('#a'), { signal: controller.signal })
    controller.abort()
    expect(failed(await pending).failure).toBe('unknown')
    const early = new AbortController()
    early.abort()
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw init.signal.reason
      return json({ ok: true })
    })
    expect(failed(await post(bot('#a'), { signal: early.signal })).failure).toBe('unknown')
  })

  it('passes a signal that fires on the timeout', async () => {
    const calls = stub(() => json({ ok: true }))
    await post(bot('#a'))
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]!.signal!.aborted).toBe(false)
  })
})

describe('postSlackMessage with a webhook url', () => {
  it('posts the text as JSON to the url and nothing else', async () => {
    const calls = stub(() => new Response('ok', { status: 200 }))
    expect(await post(WEBHOOK)).toEqual({ ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(WEBHOOK)
    expect(call.method).toBe('POST')
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.headers.get('authorization')).toBeNull()
    expect(call.redirect).toBe('manual')
    expect(JSON.parse(call.body)).toEqual({ text: 'Workflow "w" failed.' })
  })

  it('gives a connection failure for a channel and sends nothing', async () => {
    const calls = stub(() => new Response('ok', { status: 200 }))
    const result = failed(await post(WEBHOOK, { channel: '#alerts' }))
    expect(result.failure).toBe('connection')
    expect(result.error.message).toBe('this Slack connection is a webhook URL and posts to its own channel; remove the channel of this step or use a bot token connection')
    expect(result.error).not.toBeInstanceOf(RetryableError)
    expect(calls).toHaveLength(0)
  })

  it('gives an HTTP status failure and a timeout failure, and never names the url', async () => {
    stub(() => new Response('no', { status: 404 }))
    const status = failed(await post(WEBHOOK))
    expect(status.failure).toBe('http_status')
    expect(status.error.message).not.toContain('POSTWEBHOOKMARKER')
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timeout', 'TimeoutError')
    })
    const slow = failed(await post(WEBHOOK))
    expect(slow.failure).toBe('timeout')
    expect(slow.error.message).not.toContain('POSTWEBHOOKMARKER')
  })
})

describe('postSlackMessage with a secret that is neither', () => {
  it('gives a connection failure with the fixed text and sends nothing', async () => {
    const calls = stub(() => json({ ok: true }))
    for (const secret of ['hooks.slack.com/services/T000/B000/SECRETTOKEN', 'xoxp-SLACKTOKENMARKER0123', JSON.stringify({ rillSlack: 1, token: BOT_TOKEN, extra: 1 }), 'ftp://x/SECRETTOKEN', '']) {
      const result = failed(await post(secret))
      expect(result.failure).toBe('connection')
      expect(result.error.message).toBe('the Slack connection is not a webhook URL or a bot token')
      expect(result.error).not.toBeInstanceOf(RetryableError)
    }
    expect(calls).toHaveLength(0)
  })
})
