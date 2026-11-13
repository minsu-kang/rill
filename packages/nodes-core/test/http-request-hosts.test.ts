import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetryableError, hostCheckFor, type NodeContext } from '../src/index'
import { encodeConnectionSecret } from '../src/connection-auth'
import { httpRequest } from '../src/nodes/http-request'
import { jsonResponse, stubFetch } from './fetch-stub'
import { makeCtx } from './helpers'

const FIXED = 'this host is not in the allowed hosts'
const MARKER = 'SECRET-MARKER-5d27'

afterEach(() => {
  vi.unstubAllGlobals()
})

function ctxWith(hostAllowed: ((url: string) => boolean) | undefined, overrides: Partial<NodeContext> = {}): NodeContext {
  return makeCtx({ ...(hostAllowed === undefined ? {} : { hostAllowed }), ...overrides })
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to fail')
}

describe('http.request@1 with an allowed-hosts check in the context', () => {
  it('behaves as before when the context has no check', async () => {
    const seen = stubFetch(jsonResponse({ ok: true }))
    const ctx = ctxWith(undefined)
    expect('hostAllowed' in ctx).toBe(false)
    expect(await httpRequest.execute({ url: 'https://evil.com/x' }, ctx)).toMatchObject({ status: 200, body: { ok: true } })
    expect(seen).toHaveLength(1)
  })

  it('makes the request when the check allows the URL, and hands the check the final URL', async () => {
    const seen = stubFetch(jsonResponse({ ok: true }))
    const asked: string[] = []
    const output = await httpRequest.execute({ url: 'https://api.example.com/v1/items?x=1#frag' }, ctxWith((url) => (asked.push(url), true)))
    expect(output).toMatchObject({ status: 200 })
    expect(asked).toEqual(['https://api.example.com/v1/items?x=1#frag'])
    expect(seen.map((call) => call.url)).toEqual(['https://api.example.com/v1/items?x=1#frag'])
  })

  it('fails with the fixed text before any request when the check refuses, and the text has no URL in it', async () => {
    const seen = stubFetch(jsonResponse({ ok: true }))
    const error = await failure(httpRequest.execute({ url: `https://evil.com/secret-path?token=${MARKER}` }, ctxWith(() => false)))
    expect(error.message).toBe(FIXED)
    expect(error.message).not.toContain('evil')
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(seen).toHaveLength(0)
  })

  it('refuses a templated URL that resolved to a host that is not allowed', async () => {
    const seen = stubFetch(jsonResponse({}))
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts: ['api.example.com'] })!
    const resolved = 'https://evil.com/v1'
    expect((await failure(httpRequest.execute({ url: resolved }, ctxWith(check)))).message).toBe(FIXED)
    expect(seen).toHaveLength(0)
    expect(await httpRequest.execute({ url: 'https://api.example.com/v1' }, ctxWith(check))).toMatchObject({ status: 200 })
    expect(seen).toHaveLength(1)
  })

  it('judges the real host of a tricky URL', async () => {
    const seen = stubFetch(jsonResponse({}))
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts: ['allowed.com'] })!
    for (const url of ['https://allowed.com@evil.com/', 'https://allowed.com.evil.com/', 'https://evil.com/?h=allowed.com', 'https://allowed.com%2eevil.com/']) {
      expect((await failure(httpRequest.execute({ url }, ctxWith(check)))).message, url).toBe(FIXED)
    }
    expect(seen).toHaveLength(0)
    await httpRequest.execute({ url: 'https://ALLOWED.com:8443/x#f' }, ctxWith(check))
    expect(seen).toHaveLength(1)
  })

  it('checks the URL a query credential builds, and keeps the credential out of the failure', async () => {
    const seen = stubFetch(jsonResponse({}))
    const asked: string[] = []
    const connections = { get: () => encodeConnectionSecret({ type: 'apiKey', in: 'query', name: 'key', value: MARKER }) }
    const refuse = ctxWith((url) => (asked.push(url), false), { connections })
    const error = await failure(httpRequest.execute({ url: 'https://evil.com/x?a=1', auth: { connection: 'api' } }, refuse))
    expect(error.message).toBe(FIXED)
    expect(error.message).not.toContain(MARKER)
    expect(asked).toEqual([`https://evil.com/x?a=1&key=${MARKER}`])
    expect(seen).toHaveLength(0)
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts: ['api.example.com'] })!
    await httpRequest.execute({ url: 'https://api.example.com/x', auth: { connection: 'api' } }, ctxWith(check, { connections }))
    expect(seen.map((call) => call.url)).toEqual([`https://api.example.com/x?key=${MARKER}`])
  })

  it('checks the host with a header credential too', async () => {
    const seen = stubFetch(jsonResponse({}))
    const connections = { get: () => 'tok123' }
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts: ['api.example.com'] })!
    expect((await failure(httpRequest.execute({ url: 'https://evil.com/', auth: { connection: 'api' } }, ctxWith(check, { connections })))).message).toBe(FIXED)
    expect(seen).toHaveLength(0)
  })

  it('makes no request and no check in a dry run', async () => {
    const seen = stubFetch(jsonResponse({}))
    const check = vi.fn(() => false)
    const output = await httpRequest.execute({ url: 'https://evil.com/' }, ctxWith(check, { dryRun: true }))
    expect(output).toEqual({ status: 0, headers: {}, body: null, dryRun: true })
    expect(check).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('does not follow a redirect to another host: it fails as before', async () => {
    const seen = stubFetch(new Response(null, { status: 302, headers: { location: 'https://evil.com/' } }))
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts: ['api.example.com'] })!
    expect((await failure(httpRequest.execute({ url: 'https://api.example.com/x' }, ctxWith(check)))).message).toBe('HTTP 302: redirects are not followed')
    expect(seen).toHaveLength(1)
  })

  it('keeps the config error that comes before the check', async () => {
    stubFetch(jsonResponse({}))
    const error = await failure(httpRequest.execute({ url: 'https://api.example.com/x', body: { a: 1 } }, ctxWith(() => false)))
    expect(error.message).toBe('GET requests cannot have a body')
  })
})
