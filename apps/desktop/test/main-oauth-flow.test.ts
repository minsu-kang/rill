// @vitest-environment node
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_TIMEOUT_MS, REQUEST_TIMEOUT_MS, buildAuthorizeUrl, createPkcePair, createStateValue, refreshTokens, revokeRefreshToken, startSignIn, type FlowDeps, type SignIn } from '../src/main/oauth-flow'
import { HostError, type OAuthProvider } from '../src/shared/host-api'
import {
  GOOGLE_ACCESS,
  GOOGLE_ACCESS_2,
  GOOGLE_APP,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH,
  GOOGLE_REFRESH_2,
  GOOGLE_SCOPE,
  ManualClock,
  MICROSOFT_ACCESS,
  MICROSOFT_APP,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_REFRESH,
  deferred,
  httpCall,
  json,
  microsoftTokenAnswer,
  recordingFetch,
  refuses,
  scanFor,
  settle,
  tokenAnswer,
  type RecordedCall,
} from './oauth-helpers'

const servers: Server[] = []
const flows: SignIn[] = []

afterEach(async () => {
  for (const flow of flows.splice(0)) {
    flow.cancel()
    await flow.done.catch(() => undefined)
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

interface Setup {
  provider?: OAuthProvider
  app?: { clientId: string; clientSecret?: string }
  respond?: (call: RecordedCall) => Response | Promise<Response>
  random?: (size: number) => Buffer
  openExternal?: (url: string) => Promise<void>
  createServer?: FlowDeps['createServer']
}

const userinfo = (call: RecordedCall): Response => (call.url.includes('userinfo') ? json({ email: 'someone@example.com' }) : json({}, 404))

function defaultRespond(provider: OAuthProvider): (call: RecordedCall) => Response {
  if (provider === 'google') return (call) => (call.url === 'https://oauth2.googleapis.com/token' ? tokenAnswer() : userinfo(call))
  return (call) => (call.url.endsWith('/token') ? microsoftTokenAnswer() : call.url.includes('graph.microsoft.com') ? json({ displayName: 'Alex Doe', mail: 'alex@contoso.example' }) : json({}, 404))
}

async function start(setup: Setup = {}) {
  const provider = setup.provider ?? 'google'
  const app = setup.app ?? (provider === 'google' ? GOOGLE_APP : MICROSOFT_APP)
  const clock = new ManualClock()
  const { fetch, calls } = recordingFetch(setup.respond ?? defaultRespond(provider))
  const opened = deferred<string>()
  const urls: string[] = []
  const deps: FlowDeps = {
    fetch,
    clock,
    openExternal:
      setup.openExternal ??
      (async (url) => {
        urls.push(url)
        opened.resolve(url)
      }),
    ...(setup.random === undefined ? {} : { randomBytes: setup.random }),
    ...(setup.createServer === undefined ? {} : { createServer: setup.createServer }),
  }
  const signIn = startSignIn({ provider, app, deps })
  flows.push(signIn)
  const settled = signIn.done.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const url = setup.openExternal === undefined ? await opened.promise : undefined
  const params = url === undefined ? new URLSearchParams() : new URL(url).searchParams
  const redirect = params.get('redirect_uri') === null ? undefined : new URL(params.get('redirect_uri')!)
  const port = redirect === undefined ? 0 : Number(redirect.port)
  return {
    provider,
    clock,
    calls,
    urls,
    signIn,
    settled,
    url,
    params,
    port,
    state: params.get('state') ?? '',
    callback: (query: Record<string, string | undefined> | string, options: { path?: string; method?: string; host?: string } = {}) =>
      httpCall({ port, path: `${options.path ?? '/oauth/callback'}?${typeof query === 'string' ? query : new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString()}`, ...(options.method === undefined ? {} : { method: options.method }), ...(options.host === undefined ? {} : { host: options.host }) }),
  }
}

async function complete(setup: Setup = {}, code = 'AUTHCODEMARKER-4/0AfJohXmcode') {
  const flow = await start(setup)
  const answer = await flow.callback({ code, state: flow.state })
  const outcome = await flow.settled
  return { flow, answer, outcome }
}

function errorOf(outcome: { ok: boolean; error?: unknown }): HostError {
  expect(outcome.ok).toBe(false)
  expect(outcome.error).toBeInstanceOf(HostError)
  return outcome.error as HostError
}

describe('PKCE and state values', () => {
  it('makes a verifier of 43 to 128 unreserved characters from the random source, and the S256 challenge of it', () => {
    const { verifier, challenge } = createPkcePair((size) => Buffer.alloc(size, 7))
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('makes different verifiers from different random bytes, and uses all the random bytes it is given', () => {
    const a = createPkcePair((size) => Buffer.alloc(size, 1))
    const b = createPkcePair((size) => Buffer.alloc(size, 2))
    expect(a.verifier).not.toBe(b.verifier)
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })

  it('makes a 32 character hex state', () => {
    expect(createStateValue((size) => Buffer.alloc(size, 0xab))).toBe('ab'.repeat(16))
    expect(createStateValue()).toMatch(/^[0-9a-f]{32}$/)
    expect(createStateValue()).not.toBe(createStateValue())
  })
})

describe('the authorize address', () => {
  it('has exactly the Google parameters in front of the provider constants and nothing else', async () => {
    const flow = await start()
    const url = new URL(flow.url!)
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect([...url.searchParams.keys()].sort()).toEqual(['access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'])
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${flow.port}/oauth/callback`)
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/spreadsheets')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/)
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(flow.port).toBeGreaterThan(0)
  })

  it('has exactly the Microsoft parameters, with localhost as the redirect host', async () => {
    const flow = await start({ provider: 'microsoft' })
    const url = new URL(flow.url!)
    expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'])
    expect(url.searchParams.get('client_id')).toBe(MICROSOFT_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:${flow.port}/oauth/callback`)
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite')
    expect(url.searchParams.get('prompt')).toBe('select_account')
  })

  it('never carries the client secret, and is opened exactly once', async () => {
    const flow = await start()
    expect(flow.urls).toHaveLength(1)
    expect(flow.url).not.toContain(GOOGLE_CLIENT_SECRET)
    expect(flow.url).not.toContain('client_secret')
  })

  it('builds the same address from the same inputs, with every value encoded', () => {
    const input = { provider: 'google' as const, clientId: 'id with space&x=1', redirectUri: 'http://127.0.0.1:5/oauth/callback', state: 'a'.repeat(32), challenge: 'c'.repeat(43) }
    const url = new URL(buildAuthorizeUrl(input))
    expect(url.searchParams.get('client_id')).toBe('id with space&x=1')
    expect(url.searchParams.has('x')).toBe(false)
    expect(buildAuthorizeUrl(input)).toBe(buildAuthorizeUrl(input))
  })

  it('uses a different port and state for every flow', async () => {
    const first = await start()
    const second = await start()
    expect(first.state).not.toBe(second.state)
    expect(first.port).not.toBe(second.port)
  })

  it('binds the loopback address only, on a port the system picks', async () => {
    const listens: unknown[][] = []
    const flow = await start({
      createServer: (listener) => {
        const server = createServer(listener)
        const listen = server.listen.bind(server) as (...args: unknown[]) => Server
        server.listen = ((...args: unknown[]) => (listens.push(args), listen(...args))) as typeof server.listen
        return server
      },
    })
    expect(flow.port).toBeGreaterThan(0)
    expect(listens).toHaveLength(1)
    expect(JSON.stringify(listens[0])).toBe(JSON.stringify([{ port: 0, host: '127.0.0.1' }]))
  })
})

describe('the loopback server', () => {
  it('answers 404 to another path, another method and a wrong host, and keeps waiting', async () => {
    const flow = await start()
    const base = { code: 'x', state: flow.state }
    expect((await flow.callback(base, { path: '/' })).status).toBe(404)
    expect((await flow.callback(base, { path: '/oauth/callback/' })).status).toBe(404)
    expect((await flow.callback(base, { path: '/oauth/callbackx' })).status).toBe(404)
    expect((await flow.callback(base, { path: '/other' })).status).toBe(404)
    expect((await flow.callback(base, { method: 'POST' })).status).toBe(404)
    expect((await flow.callback(base, { method: 'HEAD' })).status).toBe(404)
    expect((await flow.callback(base, { host: 'evil.example' })).status).toBe(404)
    expect((await flow.callback(base, { host: `evil.example:${flow.port}` })).status).toBe(404)
    expect((await flow.callback(base, { host: `127.0.0.1:${flow.port + 1}` })).status).toBe(404)
    expect((await flow.callback(base, { host: '127.0.0.1' })).status).toBe(404)
    expect((await flow.callback(base, { host: `localhost.evil.example:${flow.port}` })).status).toBe(404)
    expect(flow.calls).toHaveLength(0)
    expect((await flow.callback(base)).status).toBe(200)
    expect((await flow.settled).ok).toBe(true)
  })

  it('accepts both loopback host names with the right port', async () => {
    const viaLocalhost = await start()
    expect((await viaLocalhost.callback({ code: 'x', state: viaLocalhost.state }, { host: `localhost:${viaLocalhost.port}` })).status).toBe(200)
    expect((await viaLocalhost.settled).ok).toBe(true)
    const viaIp = await start({ provider: 'microsoft' })
    expect((await viaIp.callback({ code: 'x', state: viaIp.state }, { host: `127.0.0.1:${viaIp.port}` })).status).toBe(200)
    expect((await viaIp.settled).ok).toBe(true)
  })

  it('ignores a callback with a wrong, missing, repeated or differently long state and goes on waiting', async () => {
    const flow = await start()
    const wrong = flow.state.replace(/.$/, (char) => (char === '0' ? '1' : '0'))
    for (const query of [{ code: 'x', state: wrong }, { code: 'x' }, { code: 'x', state: '' }, { code: 'x', state: flow.state.slice(0, 31) }, { code: 'x', state: `${flow.state}0` }, `code=x&state=${flow.state}&state=${flow.state}`, { error: 'access_denied', state: wrong }]) {
      const answer = await flow.callback(query)
      expect(answer.status).toBe(400)
      expect(answer.body).not.toContain(flow.state)
    }
    expect(flow.calls).toHaveLength(0)
    expect(flow.clock.pending()).toBeGreaterThan(0)
    expect((await flow.callback({ code: 'x', state: flow.state })).status).toBe(200)
    expect((await flow.settled).ok).toBe(true)
  })

  it('lets the first valid callback win and closes the server afterwards', async () => {
    const flow = await start()
    const first = await flow.callback({ code: 'x', state: flow.state })
    expect(first.status).toBe(200)
    await flow.settled
    expect(await refuses(flow.port)).toBe(true)
    expect(flow.clock.pending()).toBe(0)
  })

  it('answers a second valid callback that arrives before the server closes with 404, and exchanges the first code only', async () => {
    let listener!: RequestListener
    const flow = await start({
      createServer: (handler) => {
        listener = handler
        return createServer(handler)
      },
    })
    const request = (code: string) => ({ url: `/oauth/callback?code=${code}&state=${flow.state}`, method: 'GET', headers: { host: `127.0.0.1:${flow.port}` } }) as unknown as IncomingMessage
    const response = () => Object.assign(new EventEmitter(), { statusCode: 0, setHeader: () => undefined, end: () => undefined })
    const one = response()
    const two = response()
    listener(request('FIRSTCODE'), one as unknown as ServerResponse)
    listener(request('SECONDCODE'), two as unknown as ServerResponse)
    expect(one.statusCode).toBe(200)
    expect(two.statusCode).toBe(404)
    one.emit('finish')
    expect((await flow.settled).ok).toBe(true)
    expect(flow.calls.filter((call) => call.url.includes('/token')).map((call) => call.form.get('code'))).toEqual(['FIRSTCODE'])
  })

  it('closes the server before the code is exchanged, not after', async () => {
    const gate = deferred<Response>()
    const flow = await start({ respond: (call) => (call.url.includes('/token') ? gate.promise : userinfo(call)) })
    await flow.callback({ code: 'x', state: flow.state })
    await vi.waitFor(async () => expect(await refuses(flow.port)).toBe(true))
    gate.resolve(tokenAnswer())
    expect((await flow.settled).ok).toBe(true)
  })

  it('closes the server even when a client holds a half-sent request open', async () => {
    const flow = await start()
    const socket = connect({ host: '127.0.0.1', port: flow.port })
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write('GET /oauth/callback?code=y HTTP/1.1\r\nHost: 127.0.0.1')
    await settle()
    await flow.callback({ code: 'x', state: flow.state })
    expect((await flow.settled).ok).toBe(true)
    expect(await refuses(flow.port)).toBe(true)
    socket.destroy()
  })

  it('closes the server when the flow ends in a refusal, and when the callback is for a denial', async () => {
    const denied = await start()
    await denied.callback({ error: 'access_denied', state: denied.state })
    await denied.settled
    expect(await refuses(denied.port)).toBe(true)
  })

  it('answers with a fixed page that reflects nothing it was sent', async () => {
    const ok = await start()
    const first = await ok.callback({ code: 'AUTHCODEMARKER-reflected', state: ok.state })
    await ok.settled
    const denied = await start()
    const second = await denied.callback({ error: 'PROVIDERTEXTMARKER', error_description: 'PROVIDERTEXTMARKER', state: denied.state })
    await denied.settled
    expect(second.body).toBe(first.body)
    expect(first.body).toContain('<!doctype html>')
    expect(scanFor(first.body + second.body, ['AUTHCODEMARKER', 'PROVIDERTEXTMARKER', ok.state, denied.state])).toEqual([])
    expect(first.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.headers['referrer-policy']).toBe('no-referrer')
    expect(first.headers['x-content-type-options']).toBe('nosniff')
    expect(first.headers['content-security-policy']).toContain("default-src 'none'")
    expect(first.headers.connection).toBe('close')
    expect(first.body).not.toMatch(/<script|<img|<link|https?:\/\//i)
  })

  it('answers the wrong-state reply with fixed text too', async () => {
    const flow = await start()
    const answer = await flow.callback({ code: 'AUTHCODEMARKER-x', state: 'PROVIDERTEXTMARKER' })
    expect(answer.status).toBe(400)
    expect(scanFor(answer.body)).toEqual([])
    expect(answer.headers['cache-control']).toBe('no-store')
  })

  it('ends with OAUTH_TIMEOUT after three minutes and closes the server', async () => {
    const flow = await start()
    await flow.clock.advance(OAUTH_TIMEOUT_MS - 1)
    expect(flow.clock.pending()).toBeGreaterThan(0)
    await flow.clock.advance(1)
    expect(errorOf(await flow.settled).code).toBe('OAUTH_TIMEOUT')
    expect(await refuses(flow.port)).toBe(true)
    expect(flow.calls).toHaveLength(0)
  })

  it('ends with OAUTH_CANCELLED when cancelled, closes the server, and ignores a second cancel', async () => {
    const flow = await start()
    flow.signIn.cancel()
    flow.signIn.cancel()
    expect(errorOf(await flow.settled).code).toBe('OAUTH_CANCELLED')
    expect(await refuses(flow.port)).toBe(true)
    expect(flow.clock.pending()).toBe(0)
  })

  it('ends with OAUTH_DENIED for an error parameter and never shows its text', async () => {
    const flow = await start()
    const answer = await flow.callback({ error: 'access_denied', error_description: 'PROVIDERTEXTMARKER', state: flow.state })
    expect(answer.status).toBe(200)
    const error = errorOf(await flow.settled)
    expect(error.code).toBe('OAUTH_DENIED')
    expect(scanFor(error.message + String(error.stack ?? '') + JSON.stringify(error))).toEqual([])
    expect(flow.calls).toHaveLength(0)
  })

  it('ends with OAUTH_EXCHANGE_FAILED for a valid callback that has no code, an empty code, two codes or a huge code', async () => {
    for (const query of [(state: string) => ({ state }), (state: string) => ({ code: '', state }), (state: string) => `code=a&code=b&state=${state}`, (state: string) => ({ code: 'c'.repeat(4097), state })]) {
      const flow = await start()
      await flow.callback(query(flow.state))
      expect(errorOf(await flow.settled).code).toBe('OAUTH_EXCHANGE_FAILED')
      expect(flow.calls).toHaveLength(0)
    }
  })

  it('fails with OAUTH_EXCHANGE_FAILED and closes the server when the browser cannot be opened', async () => {
    const closed = deferred<number>()
    const flow = await start({
      openExternal: async () => {
        throw new Error('no browser PROVIDERTEXTMARKER')
      },
      createServer: (listener) => {
        const server = createServer(listener)
        server.on('listening', () => closed.resolve((server.address() as { port: number }).port))
        servers.push(server)
        return server
      },
    })
    const error = errorOf(await flow.settled)
    expect(error.code).toBe('OAUTH_EXCHANGE_FAILED')
    expect(scanFor(error.message)).toEqual([])
    expect(await refuses(await closed.promise)).toBe(true)
  })

  it('fails with OAUTH_EXCHANGE_FAILED when the server cannot listen', async () => {
    const flow = await start({
      openExternal: async () => undefined,
      createServer: () => {
        const server = createServer()
        server.listen = (() => {
          queueMicrotask(() => server.emit('error', Object.assign(new Error('EADDRINUSE PROVIDERTEXTMARKER'), { code: 'EADDRINUSE' })))
          return server
        }) as typeof server.listen
        return server
      },
    })
    const error = errorOf(await flow.settled)
    expect(error.code).toBe('OAUTH_EXCHANGE_FAILED')
    expect(scanFor(error.message)).toEqual([])
  })
})

describe('the code exchange', () => {
  it('posts a form to the Google token endpoint with the verifier that matches the challenge, and the secret', async () => {
    const { flow, outcome } = await complete()
    expect(outcome.ok).toBe(true)
    const token = flow.calls.find((call) => call.url === 'https://oauth2.googleapis.com/token')!
    expect(token.init.method).toBe('POST')
    expect(token.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(token.init.credentials).toBe('omit')
    expect(token.init.redirect).toBe('error')
    expect(token.init.signal).toBeInstanceOf(AbortSignal)
    expect([...token.form.keys()].sort()).toEqual(['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri'])
    expect(token.form.get('grant_type')).toBe('authorization_code')
    expect(token.form.get('code')).toBe('AUTHCODEMARKER-4/0AfJohXmcode')
    expect(token.form.get('redirect_uri')).toBe(`http://127.0.0.1:${flow.port}/oauth/callback`)
    expect(token.form.get('client_id')).toBe(GOOGLE_CLIENT_ID)
    expect(token.form.get('client_secret')).toBe(GOOGLE_CLIENT_SECRET)
    const verifier = token.form.get('code_verifier')!
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(flow.params.get('code_challenge'))
    expect(token.url).not.toContain('AUTHCODEMARKER')
  })

  it('sends no client secret when Google has none', async () => {
    const { flow, outcome } = await complete({ app: { clientId: GOOGLE_CLIENT_ID } })
    expect(outcome.ok).toBe(true)
    expect(flow.calls[0]!.form.has('client_secret')).toBe(false)
  })

  it('never sends a client secret to Microsoft, even when the app record holds one', async () => {
    const { flow, outcome } = await complete({ provider: 'microsoft', app: { clientId: MICROSOFT_CLIENT_ID, clientSecret: 'CLIENTSECRETMARKER-must-not-leave' } })
    expect(outcome.ok).toBe(true)
    expect(flow.calls[0]!.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    expect(flow.calls[0]!.form.has('client_secret')).toBe(false)
    expect(scanFor(JSON.stringify(flow.calls.map((call) => [call.url, call.init.body])), ['CLIENTSECRETMARKER'])).toEqual([])
  })

  it('returns the tokens, the scope, the expiry from the clock and the account name', async () => {
    const { flow, outcome } = await complete()
    expect(outcome).toEqual({
      ok: true,
      value: { accessToken: GOOGLE_ACCESS, refreshToken: GOOGLE_REFRESH, scope: GOOGLE_SCOPE, expiresAt: flow.clock.now() + 3599_000, account: 'someone@example.com' },
    })
  })

  it('asks for the account name with the access token only in the Authorization header', async () => {
    const { flow } = await complete()
    const info = flow.calls.find((call) => call.url === 'https://openidconnect.googleapis.com/v1/userinfo')!
    expect(info.init.method).toBe('GET')
    expect(info.init.headers.Authorization).toBe(`Bearer ${GOOGLE_ACCESS}`)
    expect(info.init.credentials).toBe('omit')
    expect(info.init.redirect).toBe('error')
    expect(info.url).not.toContain(GOOGLE_ACCESS)
    expect(info.init.body).toBeUndefined()
  })

  it('takes the Microsoft display name first, then the mail, then the user principal name', async () => {
    const names = async (answer: Record<string, unknown>) => {
      const { outcome } = await complete({ provider: 'microsoft', respond: (call) => (call.url.endsWith('/token') ? microsoftTokenAnswer() : json(answer)) })
      return outcome.ok ? outcome.value.account : 'failed'
    }
    expect(await names({ displayName: 'Alex Doe', mail: 'alex@contoso.example', userPrincipalName: 'upn@contoso.example' })).toBe('Alex Doe')
    expect(await names({ mail: 'alex@contoso.example', userPrincipalName: 'upn@contoso.example' })).toBe('alex@contoso.example')
    expect(await names({ displayName: '', mail: null, userPrincipalName: 'upn@contoso.example' })).toBe('upn@contoso.example')
    expect(await names({ displayName: 5, mail: ['x'] })).toBeUndefined()
  })

  it('takes the Google email first, then the name', async () => {
    const names = async (answer: Record<string, unknown>) => {
      const { outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer() : json(answer)) })
      return outcome.ok ? outcome.value.account : 'failed'
    }
    expect(await names({ email: 'a@b.example', name: 'A B' })).toBe('a@b.example')
    expect(await names({ name: 'A B' })).toBe('A B')
  })

  it('cleans an account text from the provider: control and direction characters out, 200 characters at most, never the token', async () => {
    const answer = async (value: unknown) => {
      const { outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer() : json({ email: value })) })
      return outcome.ok ? outcome.value.account : 'failed'
    }
    expect(await answer('a\u0000b\u0007c‮d‎e⁧f')).toBe('abcdef')
    expect(await answer(`${'x'.repeat(250)}`)).toBe('x'.repeat(200))
    expect(await answer(`x${'😀'.repeat(150)}`)).toMatch(/^x(?:😀){99}$/u)
    expect(await answer(`mail ${GOOGLE_ACCESS}`)).toBeUndefined()
    expect(await answer('   ')).toBeUndefined()
    expect(await answer('\u0000\u0001')).toBeUndefined()
  })

  it('still connects without a name when the account request fails in any way', async () => {
    const failures: Array<(call: RecordedCall) => Response | Promise<Response>> = [
      (call) => (call.url.includes('/token') ? tokenAnswer() : json({ error: 'PROVIDERTEXTMARKER' }, 401)),
      (call) => (call.url.includes('/token') ? tokenAnswer() : json({}, 500)),
      (call) => (call.url.includes('/token') ? tokenAnswer() : new Response('not json', { status: 200 })),
      (call) => (call.url.includes('/token') ? tokenAnswer() : json({ email: 5 })),
      (call) => {
        if (call.url.includes('/token')) return tokenAnswer()
        throw new Error('network PROVIDERTEXTMARKER')
      },
    ]
    for (const respond of failures) {
      const { outcome } = await complete({ respond })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.value.account).toBeUndefined()
    }
  })

  it('accepts a grant whose answer has no scope, because the scope then equals the request', async () => {
    const { outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ scope: undefined }) : userinfo(call)) })
    expect(outcome.ok).toBe(true)
  })

  it('accepts a numeric string for expires_in', async () => {
    const { outcome, flow } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ expires_in: '3600' }) : userinfo(call)) })
    expect(outcome.ok && outcome.value.expiresAt).toBe(flow.clock.now() + 3600_000)
  })

  it('refuses with OAUTH_SCOPE_MISSING when the answer has no refresh token, and never asks for the account name', async () => {
    const { flow, outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ refresh_token: undefined }) : userinfo(call)) })
    expect(errorOf(outcome).code).toBe('OAUTH_SCOPE_MISSING')
    expect(flow.calls).toHaveLength(1)
  })

  it('refuses with OAUTH_SCOPE_MISSING when the user unticked the data scope', async () => {
    for (const scope of ['openid https://www.googleapis.com/auth/userinfo.email', '', 'https://www.googleapis.com/auth/spreadsheets.readonly']) {
      const { outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ scope }) : userinfo(call)) })
      expect(errorOf(outcome).code, scope).toBe('OAUTH_SCOPE_MISSING')
    }
    const { outcome } = await complete({ provider: 'microsoft', respond: (call) => (call.url.endsWith('/token') ? microsoftTokenAnswer({ scope: 'User.Read Files.Read' }) : json({})) })
    expect(errorOf(outcome).code).toBe('OAUTH_SCOPE_MISSING')
  })

  it('revokes the Google refresh token of a grant that lacks a data scope, before it ends with OAUTH_SCOPE_MISSING', async () => {
    const { flow, outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ scope: 'openid https://www.googleapis.com/auth/userinfo.email' }) : call.url.includes('/revoke') ? new Response('', { status: 200 }) : userinfo(call)) })
    expect(errorOf(outcome).code).toBe('OAUTH_SCOPE_MISSING')
    expect(flow.calls.map((call) => call.url)).toEqual(['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke'])
    expect(flow.calls[1]!.init.method).toBe('POST')
    expect(flow.calls[1]!.form.get('token')).toBe(GOOGLE_REFRESH)
    expect(scanFor(JSON.stringify(errorOf(outcome)))).toEqual([])
  })

  it('still ends with OAUTH_SCOPE_MISSING when the revoke of a short grant fails or is refused', async () => {
    const failing = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ scope: 'openid' }) : call.url.includes('/revoke') ? Promise.reject(new Error('offline PROVIDERTEXTMARKER')) : userinfo(call)) })
    expect(errorOf(failing.outcome).code).toBe('OAUTH_SCOPE_MISSING')
    expect(failing.flow.calls.filter((call) => call.url.includes('/revoke'))).toHaveLength(1)
    const refused = await complete({ respond: (call) => (call.url.includes('/token') ? tokenAnswer({ scope: 'openid' }) : call.url.includes('/revoke') ? json({ error: 'invalid_token' }, 400) : userinfo(call)) })
    expect(errorOf(refused.outcome).code).toBe('OAUTH_SCOPE_MISSING')
  })

  it('has nothing to revoke for Microsoft, and revokes nothing when the grant is complete', async () => {
    const microsoft = await complete({ provider: 'microsoft', respond: (call) => (call.url.endsWith('/token') ? microsoftTokenAnswer({ scope: 'User.Read Files.Read' }) : json({})) })
    expect(errorOf(microsoft.outcome).code).toBe('OAUTH_SCOPE_MISSING')
    expect(microsoft.flow.calls).toHaveLength(1)
    const whole = await complete()
    expect(whole.outcome.ok).toBe(true)
    expect(whole.flow.calls.filter((call) => call.url.includes('/revoke'))).toEqual([])
  })

  it('maps every other failure to OAUTH_EXCHANGE_FAILED without a word of the answer', async () => {
    const wrongAccess = 'has space and \u0000 control'
    const answers: Array<[string, (call: RecordedCall) => Response | Promise<Response>]> = [
      ['400 invalid_grant', () => json({ error: 'invalid_grant', error_description: 'PROVIDERTEXTMARKER AUTHCODEMARKER' }, 400)],
      ['401', () => json({ error: 'invalid_client', error_description: 'PROVIDERTEXTMARKER' }, 401)],
      ['500', () => new Response('PROVIDERTEXTMARKER', { status: 500 })],
      ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/?c=PROVIDERTEXTMARKER' } })],
      ['not json', () => new Response('PROVIDERTEXTMARKER', { status: 200 })],
      ['json array', () => json(['PROVIDERTEXTMARKER'])],
      ['no access token', () => json({ refresh_token: GOOGLE_REFRESH, scope: GOOGLE_SCOPE, expires_in: 3599 })],
      ['malformed access token', () => tokenAnswer({ access_token: wrongAccess })],
      ['short access token', () => tokenAnswer({ access_token: 'abc' })],
      ['token too long', () => tokenAnswer({ access_token: 'a'.repeat(8193) })],
      ['no expiry', () => tokenAnswer({ expires_in: undefined })],
      ['zero expiry', () => tokenAnswer({ expires_in: 0 })],
      ['negative expiry', () => tokenAnswer({ expires_in: -5 })],
      ['text expiry', () => tokenAnswer({ expires_in: 'soon' })],
      ['not bearer', () => tokenAnswer({ token_type: 'mac' })],
      ['network', () => Promise.reject(new Error('socket PROVIDERTEXTMARKER'))],
    ]
    for (const [label, respond] of answers) {
      const { outcome } = await complete({ respond })
      const error = errorOf(outcome)
      expect(error.code, label).toBe('OAUTH_EXCHANGE_FAILED')
      expect(scanFor(error.message + String(error.stack ?? '') + JSON.stringify(error)), label).toEqual([])
    }
  })

  it('stops reading the token answer at 64 KiB', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 8192
        controller.enqueue(new Uint8Array(8192).fill(0x20))
        if (pulled > 10 * 1024 * 1024) controller.close()
      },
    })
    const { outcome } = await complete({ respond: (call) => (call.url.includes('/token') ? new Response(body, { status: 200 }) : userinfo(call)) })
    expect(errorOf(outcome).code).toBe('OAUTH_EXCHANGE_FAILED')
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * 8192)
  })

  it('gives up on a token request after 15 seconds and aborts it', async () => {
    let aborted = false
    const flow = await start({
      respond: (call) =>
        call.url.includes('/token')
          ? new Promise<Response>((_resolve, reject) => {
              call.init.signal.addEventListener('abort', () => {
                aborted = true
                reject(new Error('aborted'))
              })
            })
          : userinfo(call),
    })
    await flow.callback({ code: 'x', state: flow.state })
    await settle()
    await flow.clock.advance(REQUEST_TIMEOUT_MS)
    expect(aborted).toBe(true)
    expect(errorOf(await flow.settled).code).toBe('OAUTH_EXCHANGE_FAILED')
    expect(flow.clock.pending()).toBe(0)
  })

  it('can be cancelled while the code is being exchanged, and then stores nothing', async () => {
    const gate = deferred<Response>()
    const flow = await start({ respond: (call) => (call.url.includes('/token') ? gate.promise : userinfo(call)) })
    await flow.callback({ code: 'x', state: flow.state })
    await settle()
    flow.signIn.cancel()
    gate.resolve(tokenAnswer())
    expect(errorOf(await flow.settled).code).toBe('OAUTH_CANCELLED')
    expect(flow.calls.some((call) => call.url.includes('userinfo'))).toBe(false)
  })

  it('leaves no timer behind after a success', async () => {
    const { flow } = await complete()
    expect(flow.clock.pending()).toBe(0)
  })

  it('does not put the code, the verifier or the secret into the result or the error text', async () => {
    const { outcome } = await complete()
    const text = JSON.stringify(outcome)
    expect(scanFor(text, ['AUTHCODEMARKER', 'CLIENTSECRETMARKER'])).toEqual([])
  })
})

describe('refreshTokens', () => {
  const clock = () => new ManualClock()

  it('posts a refresh form without a scope, with the secret for Google, and returns the new access token', async () => {
    const { fetch, calls } = recordingFetch(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    const c = clock()
    const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: c } })
    expect(outcome).toEqual({ kind: 'ok', grant: { accessToken: GOOGLE_ACCESS_2, expiresAt: c.now() + 3599_000, scope: GOOGLE_SCOPE } })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://oauth2.googleapis.com/token')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(call.init.credentials).toBe('omit')
    expect(call.init.redirect).toBe('error')
    expect([...call.form.keys()].sort()).toEqual(['client_id', 'client_secret', 'grant_type', 'refresh_token'])
    expect(call.form.get('grant_type')).toBe('refresh_token')
    expect(call.form.get('refresh_token')).toBe(GOOGLE_REFRESH)
  })

  it('sends no secret for Microsoft and returns a rotated refresh token', async () => {
    const { fetch, calls } = recordingFetch(() => microsoftTokenAnswer({ access_token: MICROSOFT_ACCESS, refresh_token: 'rotated-refresh-token-value' }))
    const outcome = await refreshTokens({ provider: 'microsoft', app: MICROSOFT_APP, refreshToken: MICROSOFT_REFRESH, deps: { fetch, clock: clock() } })
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    expect(calls[0]!.form.has('client_secret')).toBe(false)
    expect(outcome.kind === 'ok' && outcome.grant.refreshToken).toBe('rotated-refresh-token-value')
  })

  it('does not require the refresh answer to name a scope', async () => {
    const { fetch } = recordingFetch(() => tokenAnswer({ scope: undefined, refresh_token: undefined }))
    const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: clock() } })
    expect(outcome.kind).toBe('ok')
  })

  it('says revoked for invalid_grant and invalid_client, whatever the status', async () => {
    for (const [status, error] of [[400, 'invalid_grant'], [401, 'invalid_client'], [400, 'invalid_client'], [401, 'invalid_grant']] as const) {
      const { fetch } = recordingFetch(() => json({ error, error_description: 'PROVIDERTEXTMARKER' }, status))
      const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: clock() } })
      expect(outcome).toEqual({ kind: 'revoked' })
    }
  })

  it('says revoked for a 400 unauthorized_client or invalid_request, which a repeat of the same request cannot cure', async () => {
    for (const error of ['unauthorized_client', 'invalid_request']) {
      for (const provider of ['google', 'microsoft'] as const) {
        const { fetch } = recordingFetch(() => json({ error, error_description: 'PROVIDERTEXTMARKER' }, 400))
        const outcome = await refreshTokens({ provider, app: provider === 'google' ? GOOGLE_APP : MICROSOFT_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: clock() } })
        expect(outcome, `${provider} ${error}`).toEqual({ kind: 'revoked' })
      }
    }
  })

  it('says transient for 5xx, 429, a network error, a timeout, unusable answers and other 4xx errors', async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => new Response('PROVIDERTEXTMARKER', { status: 500 }),
      () => new Response('PROVIDERTEXTMARKER', { status: 503 }),
      () => new Response('x', { status: 429 }),
      () => json({ error: 'invalid_request' }, 500),
      () => json({ error: 'unauthorized_client' }, 500),
      () => json({ error: 'invalid_request' }, 429),
      () => json({ error: 'temporarily_unavailable' }, 400),
      () => json({ error: 'invalid_scope' }, 400),
      () => new Response('<html>PROVIDERTEXTMARKER</html>', { status: 400 }),
      () => new Response('not json', { status: 200 }),
      () => json({ expires_in: 3599 }),
      () => json({ access_token: 'bad token with space', expires_in: 3599 }),
      () => Promise.reject(new Error('offline PROVIDERTEXTMARKER')),
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    ]
    for (const respond of cases) {
      const { fetch } = recordingFetch(respond)
      const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: clock() } })
      expect(outcome.kind).toBe('transient')
      expect(scanFor(JSON.stringify(outcome))).toEqual([])
    }
  })

  it('reports a Retry-After of seconds or a date, bounded to an hour', async () => {
    const after = async (value: string) => {
      const c = clock()
      const { fetch } = recordingFetch(() => new Response('', { status: 429, headers: { 'retry-after': value } }))
      const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: c } })
      return outcome.kind === 'transient' ? outcome.retryAfterMs : 'not transient'
    }
    expect(await after('120')).toBe(120_000)
    expect(await after('0')).toBe(0)
    expect(await after('99999')).toBe(3_600_000)
    expect(await after(new Date(1_700_000_000_000 + 90_000).toUTCString())).toBe(90_000)
    expect(await after(new Date(1_700_000_000_000 - 90_000).toUTCString())).toBe(0)
    expect(await after('soon')).toBeUndefined()
    expect(await after('-5')).toBeUndefined()
    expect(await after('1.5')).toBeUndefined()
  })

  it('times out after 15 seconds as a transient failure', async () => {
    const c = clock()
    const { fetch } = recordingFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const pending = refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: c } })
    await settle()
    await c.advance(REQUEST_TIMEOUT_MS)
    expect((await pending).kind).toBe('transient')
    expect(c.pending()).toBe(0)
  })

  it('stops reading an endless answer at 64 KiB and calls it transient', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 8192
        controller.enqueue(new Uint8Array(8192).fill(0x20))
        if (pulled > 10 * 1024 * 1024) controller.close()
      },
    })
    const { fetch } = recordingFetch(() => new Response(body, { status: 200 }))
    const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: clock() } })
    expect(outcome.kind).toBe('transient')
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * 8192)
  })

  it('returns the refresh token that the answer carries, the same one or a rotated one', async () => {
    const { fetch } = recordingFetch(() => tokenAnswer({ refresh_token: GOOGLE_REFRESH }))
    const outcome = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: clock() } })
    expect(outcome.kind === 'ok' && outcome.grant.refreshToken).toBe(GOOGLE_REFRESH)
    const rotated = recordingFetch(() => tokenAnswer({ refresh_token: GOOGLE_REFRESH_2 }))
    const next = await refreshTokens({ provider: 'google', app: GOOGLE_APP, refreshToken: GOOGLE_REFRESH, deps: { fetch: rotated.fetch, clock: clock() } })
    expect(next.kind === 'ok' && next.grant.refreshToken).toBe(GOOGLE_REFRESH_2)
  })
})

describe('revokeRefreshToken', () => {
  it('posts the refresh token to the Google revoke endpoint as a form', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('', { status: 200 }))
    await revokeRefreshToken({ provider: 'google', refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: new ManualClock() } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0]!.form.get('token')).toBe(GOOGLE_REFRESH)
    expect([...calls[0]!.form.keys()]).toEqual(['token'])
    expect(calls[0]!.init.credentials).toBe('omit')
    expect(calls[0]!.url).not.toContain(GOOGLE_REFRESH)
  })

  it('sends nothing for Microsoft', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('', { status: 200 }))
    await revokeRefreshToken({ provider: 'microsoft', refreshToken: MICROSOFT_REFRESH, deps: { fetch, clock: new ManualClock() } })
    expect(calls).toHaveLength(0)
  })

  it('ignores every error and every status', async () => {
    for (const respond of [() => new Response('', { status: 400 }), () => new Response('', { status: 500 }), () => Promise.reject(new Error('offline'))]) {
      const { fetch } = recordingFetch(respond)
      await expect(revokeRefreshToken({ provider: 'google', refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: new ManualClock() } })).resolves.toBeUndefined()
    }
  })

  it('gives up after 15 seconds', async () => {
    const c = new ManualClock()
    const { fetch } = recordingFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const pending = revokeRefreshToken({ provider: 'google', refreshToken: GOOGLE_REFRESH, deps: { fetch, clock: c } })
    await settle()
    await c.advance(REQUEST_TIMEOUT_MS)
    await expect(pending).resolves.toBeUndefined()
    expect(c.pending()).toBe(0)
  })
})
