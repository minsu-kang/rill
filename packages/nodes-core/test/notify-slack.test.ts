import Value from 'typebox/value'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetryableError, createCoreRegistry, encodeSlackBotSecret } from '../src/index'
import { notifySlack } from '../src/nodes/notify-slack'
import { closedPortUrl, startTestServer, type TestServer } from './http-server'
import { makeCtx } from './helpers'

let server: TestServer

const withConnection = (url: string) =>
  makeCtx({ connections: { get: (id) => (id === 'slack' ? url : undefined) } })

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
})

beforeEach(() => {
  server.seen.length = 0
})

describe('notify.slack@1', () => {
  it('is a registered external node', () => {
    expect(notifySlack.sideEffect).toBe('external')
    expect(createCoreRegistry().has('notify.slack@1')).toBe(true)
  })

  it('posts the text as JSON to the connection url', async () => {
    const output = await notifySlack.execute({ connection: 'slack', text: 'Receipt 12.5 saved' }, withConnection(`${server.base}/text`))
    expect(output).toEqual({ sent: true, status: 200 })
    const seen = server.seen[0]!
    expect(seen.method).toBe('POST')
    expect(seen.headers['content-type']).toBe('application/json')
    expect(JSON.parse(seen.body)).toEqual({ text: 'Receipt 12.5 saved' })
  })

  it('fails with a clear message for an unknown connection', async () => {
    await expect(notifySlack.execute({ connection: 'other', text: 'hi' }, withConnection(server.base))).rejects.toThrow(
      'unknown connection: other',
    )
    expect(server.seen).toHaveLength(0)
  })

  it('retries server errors and rate limits', async () => {
    await expect(
      notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(`${server.base}/busy`)),
    ).rejects.toBeInstanceOf(RetryableError)
    await expect(
      notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(`${server.base}/limited`)),
    ).rejects.toBeInstanceOf(RetryableError)
  })

  it('does not leak the webhook url in errors', async () => {
    const url = await closedPortUrl()
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(url)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).not.toContain(url)
  })

  it('fails fast without leaking a malformed webhook url', async () => {
    const secret = 'hooks.slack.com/services/T000/B000/SECRETTOKEN'
    const error = await notifySlack
      .execute({ connection: 'slack', text: 'hi' }, withConnection(secret))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RetryableError)
    expect((error as Error).message).not.toContain('SECRETTOKEN')
  })

  it('does not echo the url in its output', async () => {
    const output = await notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(`${server.base}/text`))
    expect(JSON.stringify(output)).not.toContain(server.base)
  })

  it('sends nothing in a dry run', async () => {
    const ctx = makeCtx({ dryRun: true, connections: { get: () => `${server.base}/text` } })
    expect(await notifySlack.execute({ connection: 'slack', text: 'hi' }, ctx)).toEqual({ sent: false, status: 0 })
    expect(server.seen).toHaveLength(0)
  })

  it('keeps posting through an https webhook url shape', async () => {
    const calls = stubSlack(() => new Response('ok', { status: 200 }))
    const hook = 'https://hooks.slack.com/services/T000/B000/WEBHOOKMARKER'
    expect(await notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(hook))).toEqual({ sent: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(hook)
    expect(calls[0]!.headers.get('authorization')).toBeNull()
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: 'hi' })
  })

  it('fails with a fixed text for a secret that is neither a webhook url nor a bot token', async () => {
    const calls = stubSlack(() => new Response('ok', { status: 200 }))
    const secrets = ['hooks.slack.com/services/T000/B000/SECRETTOKEN', 'xoxp-SLACKTOKENMARKER0123', JSON.stringify({ rillSlack: 1, token: BOT_TOKEN, extra: 1 }), 'ftp://x/SECRETTOKEN', '']
    for (const secret of secrets) {
      const error = await notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(secret)).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect((error as Error).message).toBe('the Slack connection is not a webhook URL or a bot token')
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses a channel on a webhook connection and sends nothing', async () => {
    const calls = stubSlack(() => new Response('ok', { status: 200 }))
    const error = await notifySlack
      .execute({ connection: 'slack', text: 'hi', channel: '#alerts' }, withConnection(`${server.base}/text`))
      .catch((e: unknown) => e)
    expect((error as Error).message).toBe(
      'this Slack connection is a webhook URL and posts to its own channel; remove the channel of this step or use a bot token connection',
    )
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(server.seen).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

const BOT_TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const POST_URL = 'https://slack.com/api/chat.postMessage'

interface Call {
  url: string
  method: string
  headers: Headers
  body: string
  redirect: string | undefined
}

function stubSlack(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
    }
    calls.push(call)
    return respond(call)
  })
  return calls
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
const bot = (channel?: string) => encodeSlackBotSecret({ token: BOT_TOKEN, ...(channel === undefined ? {} : { channel }) })

describe('notify.slack@1 with a bot token connection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts chat.postMessage with the token in the header and the channel of the step', async () => {
    const calls = stubSlack(() => json({ ok: true, ts: '1.2' }))
    const output = await notifySlack.execute({ connection: 'slack', text: 'Receipt 12.5 saved', channel: '#alerts' }, withConnection(bot('#default')))
    expect(output).toEqual({ sent: true, status: 200 })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(POST_URL)
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Bearer ${BOT_TOKEN}`)
    expect(call.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(call.redirect).toBe('manual')
    expect(JSON.parse(call.body)).toEqual({ channel: '#alerts', text: 'Receipt 12.5 saved' })
    expect(call.body).not.toContain(BOT_TOKEN)
  })

  it('uses the default channel of the connection when the step has none', async () => {
    const calls = stubSlack(() => json({ ok: true }))
    await notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(bot('C0123ABCDEF')))
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: 'C0123ABCDEF', text: 'hi' })
  })

  it('works with a plain token when the step names a channel', async () => {
    const calls = stubSlack(() => json({ ok: true }))
    await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#ops' }, withConnection(BOT_TOKEN))
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: '#ops', text: 'hi' })
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${BOT_TOKEN}`)
  })

  it('fails without any request when no channel is known', async () => {
    const calls = stubSlack(() => json({ ok: true }))
    for (const secret of [bot(), BOT_TOKEN]) {
      const error = await notifySlack.execute({ connection: 'slack', text: 'hi' }, withConnection(secret)).catch((e: unknown) => e)
      expect((error as Error).message).toBe('no Slack channel: set the channel of this step or give the connection a default channel')
      expect(error).not.toBeInstanceOf(RetryableError)
    }
    expect(calls).toHaveLength(0)
  })

  it('fails with the unknown connection text', async () => {
    const calls = stubSlack(() => json({ ok: true }))
    await expect(notifySlack.execute({ connection: 'other', text: 'hi', channel: '#a' }, withConnection(bot()))).rejects.toThrow('unknown connection: other')
    expect(calls).toHaveLength(0)
  })

  it('sends nothing in a dry run', async () => {
    const calls = stubSlack(() => json({ ok: true }))
    const ctx = makeCtx({ dryRun: true, connections: { get: () => bot('#a') } })
    expect(await notifySlack.execute({ connection: 'slack', text: 'hi' }, ctx)).toEqual({ sent: false, status: 0 })
    expect(calls).toHaveLength(0)
  })

  it('does not echo the token or the response in its output', async () => {
    stubSlack(() => json({ ok: true, message: { text: 'hi' } }))
    const output = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot()))
    expect(JSON.stringify(output)).toBe('{"sent":true,"status":200}')
  })

  it.each([
    ['channel_not_found', 'Slack: channel_not_found'],
    ['not_in_channel', 'Slack: not_in_channel'],
    ['invalid_auth', 'Slack: invalid_auth'],
    ['Bad Code!', 'Slack: unknown_error'],
    ['UPPER', 'Slack: unknown_error'],
    ['a'.repeat(65), 'Slack: unknown_error'],
    ['', 'Slack: unknown_error'],
    [42, 'Slack: unknown_error'],
    [undefined, 'Slack: unknown_error'],
    [null, 'Slack: unknown_error'],
  ])('maps ok false with error %j to a fixed failure', async (code, message) => {
    stubSlack(() => json({ ok: false, error: code }))
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect((error as Error).message).toBe(message)
    expect(error).not.toBeInstanceOf(RetryableError)
  })

  it('accepts a 64 character code', async () => {
    const code = 'a'.repeat(64)
    stubSlack(() => json({ ok: false, error: code }))
    await expect(notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot()))).rejects.toThrow(`Slack: ${code}`)
  })

  it.each(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])('retries the code %s', async (code) => {
    stubSlack(() => json({ ok: false, error: code }))
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe(`Slack: ${code}`)
  })

  it.each([429, 500, 502, 503])('retries HTTP %i', async (status) => {
    stubSlack(() => json({ ok: false, error: 'ratelimited' }, status))
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe(`HTTP ${status}`)
  })

  it('fails a 4xx with the status and a short body', async () => {
    stubSlack(() => new Response('forbidden here', { status: 403 }))
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe('HTTP 403: forbidden here')
  })

  it.each([
    ['plain text', () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })],
    ['html', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a broken json body', () => new Response('{"ok":', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['json without ok', () => json({ result: 'fine' })],
    ['json with a string ok', () => json({ ok: 'true' })],
    ['a json array', () => json([{ ok: true }])],
    ['json null', () => json(null)],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('treats %s as an unexpected response', async (_label, respond) => {
    stubSlack(respond)
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect((error as Error).message).toBe('Slack: unexpected_response')
    expect(error).not.toBeInstanceOf(RetryableError)
  })

  it('reads a json body that arrives without a json content type', async () => {
    stubSlack(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot()))).toEqual({ sent: true, status: 200 })
  })

  it('refuses a redirect', async () => {
    stubSlack(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }))
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect((error as Error).message).toBe('HTTP 302: redirects are not followed')
  })

  it('retries a network failure without naming the token', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`fetch failed for ${BOT_TOKEN}`, { cause: Object.assign(new Error(BOT_TOKEN), { code: 'ECONNRESET' }) })
    })
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe('network error: ECONNRESET')
  })

  it('never puts the token into an error even when the server echoes it', async () => {
    const forms = [BOT_TOKEN, JSON.stringify(BOT_TOKEN).slice(1, -1), encodeURIComponent(BOT_TOKEN), `Bearer ${BOT_TOKEN}`]
    for (const echo of forms) {
      for (const status of [400, 401, 403, 404, 200, 500]) {
        stubSlack(() => new Response(`rejected ${echo} ${JSON.stringify({ token: echo })}`, { status, headers: { 'content-type': 'text/plain' } }))
        const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).not.toContain(BOT_TOKEN)
        expect(JSON.stringify(error)).not.toContain(BOT_TOKEN)
      }
    }
  })

  it('masks a token that a 4xx body echoes, whatever the case of its url encoding', async () => {
    stubSlack(() => new Response(`token ${BOT_TOKEN} is not allowed`, { status: 400 }))
    const error = await notifySlack.execute({ connection: 'slack', text: 'hi', channel: '#a' }, withConnection(bot())).catch((e: unknown) => e)
    expect((error as Error).message).toBe('HTTP 400: token <secret> is not allowed')
  })

  it('does not read the url from the step or the connection', async () => {
    const calls = stubSlack(() => json({ ok: true }))
    await notifySlack.execute({ connection: 'slack', text: 'hi', channel: 'https://evil.example.com/x' }, withConnection(bot()))
    expect(calls.map((call) => call.url)).toEqual([POST_URL])
  })
})

describe('notify.slack@1 config and roles', () => {
  it('accepts a channel of 1 to 80 characters and refuses the rest', () => {
    const base = { connection: 'slack', text: 'hi' }
    expect(Value.Check(notifySlack.configSchema, { ...base, channel: '#a' })).toBe(true)
    expect(Value.Check(notifySlack.configSchema, { ...base, channel: 'a'.repeat(80) })).toBe(true)
    expect(Value.Check(notifySlack.configSchema, { ...base, channel: '' })).toBe(false)
    expect(Value.Check(notifySlack.configSchema, { ...base, channel: 'a'.repeat(81) })).toBe(false)
    expect(Value.Check(notifySlack.configSchema, { ...base, channel: 5 })).toBe(false)
    expect(Value.Check(notifySlack.configSchema, { ...base, other: 1 })).toBe(false)
    expect(Value.Check(notifySlack.configSchema, base)).toBe(true)
  })

  it('gives the channel the recipient role', () => {
    expect(notifySlack.roles).toEqual({ '/connection': 'connection', '/channel': 'recipient', '/text': 'message' })
  })

  it('describes both kinds of connection and the channel', () => {
    expect(notifySlack.description).toContain('webhook connection or a bot token connection')
    expect(notifySlack.description).toContain('channel')
    expect(notifySlack.description).toContain('A crash right after sending can make a resumed run send it twice.')
  })
})
