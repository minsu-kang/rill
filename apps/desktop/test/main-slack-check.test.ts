// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSlackChecker, type SlackCheckFetch } from '../src/main/slack-check'
import { isSlackVerdict, type SlackVerdict } from '../src/shared/host-api'

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const SIXTEEN_KIB = 16 * 1024

type Recorded = { url: string; init: Parameters<SlackCheckFetch>[1] }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recorder(respond: (url: string) => Response | Promise<Response> = () => json({ ok: true, team: 'Acme', user: 'rill-bot' })) {
  const calls: Recorded[] = []
  const fetch: SlackCheckFetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url)
  }
  return { fetch, calls }
}

async function verdictOf(respond: () => Response | Promise<Response>): Promise<SlackVerdict> {
  const { fetch } = recorder(respond)
  return createSlackChecker({ fetch })(TOKEN)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('slack check: the request', () => {
  it('sends one POST to auth.test with the token only in the Authorization header', async () => {
    const { fetch, calls } = recorder()
    expect(await createSlackChecker({ fetch })(TOKEN)).toEqual({ status: 'valid', workspace: 'Acme', bot: 'rill-bot' })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://slack.com/api/auth.test')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'Rill' })
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect('body' in init).toBe(false)
    expect(url).not.toContain(TOKEN)
    expect(JSON.stringify({ ...init, headers: undefined, signal: undefined })).not.toContain(TOKEN)
  })

  it('does not take the address from the token', async () => {
    const { fetch, calls } = recorder()
    await createSlackChecker({ fetch })('xoxb-https://evil.example.com')
    expect(calls[0]!.url).toBe('https://slack.com/api/auth.test')
  })
})

describe('slack check: the verdict', () => {
  it('is valid with the workspace and the bot for ok true', async () => {
    expect(await verdictOf(() => json({ ok: true, team: 'Acme Corp', user: 'rill-bot', url: 'https://acme.slack.com/', team_id: 'T1', user_id: 'U1', bot_id: 'B1' }))).toEqual({
      status: 'valid',
      workspace: 'Acme Corp',
      bot: 'rill-bot',
    })
  })

  it('leaves out a workspace or a bot that is not a string', async () => {
    expect(await verdictOf(() => json({ ok: true, team: 5, user: 'bot' }))).toEqual({ status: 'valid', bot: 'bot' })
    expect(await verdictOf(() => json({ ok: true, team: 'Acme', user: { name: 'x' } }))).toEqual({ status: 'valid', workspace: 'Acme' })
    expect(await verdictOf(() => json({ ok: true }))).toEqual({ status: 'valid' })
    expect(await verdictOf(() => json({ ok: true, team: null, user: ['a'] }))).toEqual({ status: 'valid' })
  })

  it('removes control characters, cuts to 80 characters and leaves out a text that ends up empty', async () => {
    expect(await verdictOf(() => json({ ok: true, team: 'Ac\u0000me\n\u007fCorp\u0085', user: '  rill\tbot  ' }))).toEqual({ status: 'valid', workspace: 'AcmeCorp', bot: 'rillbot' })
    const long = await verdictOf(() => json({ ok: true, team: 'a'.repeat(200), user: 'b'.repeat(81) }))
    expect(long).toEqual({ status: 'valid', workspace: 'a'.repeat(80), bot: 'b'.repeat(80) })
    expect(await verdictOf(() => json({ ok: true, team: '\u0000\n', user: '   ' }))).toEqual({ status: 'valid' })
  })

  it('removes bidirectional override characters and a cut surrogate pair', async () => {
    const cut = `${'x'.repeat(79)}😀`
    const result = await verdictOf(() => json({ ok: true, team: 'Acme‮evil', user: cut }))
    expect(result).toEqual({ status: 'valid', workspace: 'Acmeevil', bot: 'x'.repeat(79) })
    expect(isSlackVerdict(result)).toBe(true)
  })

  it.each(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'])('is invalid for ok false with %s', async (error) => {
    expect(await verdictOf(() => json({ ok: false, error }))).toEqual({ status: 'invalid', reason: 'unauthorized' })
  })

  it('is invalid for HTTP 401', async () => {
    expect(await verdictOf(() => json({ ok: false, error: 'invalid_auth' }, 401))).toEqual({ status: 'invalid', reason: 'unauthorized' })
    expect(await verdictOf(() => new Response('nope', { status: 401 }))).toEqual({ status: 'invalid', reason: 'unauthorized' })
  })

  it.each(['missing_scope', 'access_denied', 'invalid_arguments', 'something_new', 'team_added_to_org'])('is unverified for another ok false such as %s', async (error) => {
    expect(await verdictOf(() => json({ ok: false, error }))).toEqual({ status: 'unverified', reason: 'forbidden' })
  })

  it('is unverified for ok false without a usable error', async () => {
    expect(await verdictOf(() => json({ ok: false }))).toEqual({ status: 'unverified', reason: 'forbidden' })
    expect(await verdictOf(() => json({ ok: false, error: 5 }))).toEqual({ status: 'unverified', reason: 'forbidden' })
  })

  it('maps the ratelimited error to rate_limited', async () => {
    expect(await verdictOf(() => json({ ok: false, error: 'ratelimited' }))).toEqual({ status: 'unverified', reason: 'rate_limited' })
  })

  it.each([
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
    [599, 'server_error'],
    [400, 'unexpected_status'],
    [404, 'unexpected_status'],
    [204, 'unexpected_status'],
    [302, 'unexpected_status'],
    [600, 'unexpected_status'],
  ])('maps HTTP %i to unverified %s', async (status, reason) => {
    const respond = () =>
      status === 600 ? ({ status: 600, body: null } as Response) : new Response(status === 204 ? null : JSON.stringify({ ok: true, team: 'Acme' }), { status })
    expect(await verdictOf(respond)).toEqual({ status: 'unverified', reason })
  })

  it.each([
    ['text', () => new Response('ok', { status: 200 })],
    ['a broken json body', () => new Response('{"ok":', { status: 200 })],
    ['an empty body', () => new Response(null, { status: 200 })],
    ['json without ok', () => json({ team: 'Acme' })],
    ['a string ok', () => json({ ok: 'true', team: 'Acme' })],
    ['an array', () => json([{ ok: true }])],
    ['null', () => json(null)],
  ])('is unverified with unexpected_status for %s', async (_label, respond) => {
    expect(await verdictOf(respond)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
  })

  it('is unverified with network for a network error, a redirect refusal or an unknown failure', async () => {
    for (const error of [new TypeError('fetch failed'), new TypeError('redirect mode is set to error'), 'boom', undefined]) {
      const fetch: SlackCheckFetch = async () => {
        throw error
      }
      expect(await createSlackChecker({ fetch })(TOKEN)).toEqual({ status: 'unverified', reason: 'network' })
    }
  })

  it('is unverified with timeout when the request takes longer than the limit, and aborts it', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetch: SlackCheckFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const pending = createSlackChecker({ fetch })(TOKEN)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ status: 'unverified', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })

  it('honours a shorter timeout and clears the timer after an answer', async () => {
    vi.useFakeTimers()
    const { fetch } = recorder()
    await createSlackChecker({ fetch, timeoutMs: 50 })(TOKEN)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out while the body is still arriving', async () => {
    vi.useFakeTimers()
    const fetch: SlackCheckFetch = async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(stream, { status: 200 })
    }
    const pending = createSlackChecker({ fetch })(TOKEN)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual({ status: 'unverified', reason: 'timeout' })
  })
})

describe('slack check: the body limit', () => {
  function streamed(filler: number, tail: string) {
    const encoder = new TextEncoder()
    const state = { pulled: 0, cancelled: false }
    let left = filler
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (left > 0) {
          const part = encoder.encode('x'.repeat(Math.min(1024, left)))
          left -= part.byteLength
          state.pulled += part.byteLength
          controller.enqueue(part)
          return
        }
        controller.enqueue(encoder.encode(tail))
        controller.close()
      },
      cancel() {
        state.cancelled = true
      },
    })
    return { response: new Response(stream, { status: 200 }), state }
  }

  it('reads at most 16 KiB and cancels the rest, so a result placed after the limit is not seen', async () => {
    const { response, state } = streamed(SIXTEEN_KIB, JSON.stringify({ ok: true, team: 'Acme' }))
    const { fetch } = recorder(() => response)
    expect(await createSlackChecker({ fetch })(TOKEN)).toEqual({ status: 'unverified', reason: 'unexpected_status' })
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeLessThanOrEqual(SIXTEEN_KIB + 1024)
  })

  it('reads a body just under the limit', async () => {
    const padding = 'y'.repeat(SIXTEEN_KIB - 200)
    const body = JSON.stringify({ ok: true, team: 'Acme', user: 'bot', padding })
    expect(body.length).toBeLessThan(SIXTEEN_KIB)
    expect(await verdictOf(() => new Response(body, { status: 200 }))).toEqual({ status: 'valid', workspace: 'Acme', bot: 'bot' })
  })
})

describe('slack check: the token never leaves through the result or a log', () => {
  it('returns verdicts that match the schema and hold no token for every kind of answer', async () => {
    const echo = (body: string, status = 200) => () => new Response(body, { status })
    const answers = [
      echo(JSON.stringify({ ok: true, team: TOKEN, user: TOKEN })),
      echo(JSON.stringify({ ok: false, error: TOKEN })),
      echo(TOKEN, 401),
      echo(TOKEN, 500),
      echo(TOKEN, 200),
      async () => {
        throw new Error(`failed for ${TOKEN}`)
      },
    ]
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')]
    for (const respond of answers) {
      const verdict = await verdictOf(respond)
      expect(isSlackVerdict(verdict)).toBe(true)
      expect(JSON.stringify(verdict)).not.toContain(TOKEN)
    }
    expect(await verdictOf(() => json({ ok: true, team: `my ${TOKEN} space`, user: 'bot' }))).toEqual({ status: 'valid', bot: 'bot' })
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
