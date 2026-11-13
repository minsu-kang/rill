import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RetryableError, createCoreRegistry } from '../src/index'
import { encodeConnectionSecret, type ConnectionAuth } from '../src/connection-auth'
import { httpRequest } from '../src/nodes/http-request'
import { closedPortUrl, startTestServer, type TestServer } from './http-server'
import { makeCtx } from './helpers'

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
})

beforeEach(() => {
  server.seen.length = 0
})

describe('http.request@1', () => {
  it('is a registered external node', () => {
    expect(httpRequest.sideEffect).toBe('external')
    expect(createCoreRegistry().has('http.request@1')).toBe(true)
  })

  it('parses JSON responses and sends no idempotency key on GET', async () => {
    const output = await httpRequest.execute({ url: `${server.base}/json` }, makeCtx())
    expect(output).toMatchObject({ status: 200, body: { hello: 'world' } })
    expect(server.seen[0]?.method).toBe('GET')
    expect(server.seen[0]?.headers['idempotency-key']).toBeUndefined()
  })

  it('returns text bodies as strings', async () => {
    const output = await httpRequest.execute({ url: `${server.base}/text` }, makeCtx())
    expect(output).toMatchObject({ status: 200, body: 'plain' })
  })

  it('posts a JSON body with content type and the idempotency key', async () => {
    const ctx = makeCtx({ idempotencyKey: 'run1:node1' })
    const output = await httpRequest.execute(
      { url: `${server.base}/echo`, method: 'POST', body: { amount: 12.5 }, headers: { 'X-Test': '1' } },
      ctx,
    )
    expect(output).toMatchObject({ status: 200, body: { received: '{"amount":12.5}' } })
    const seen = server.seen[0]!
    expect(seen.headers['content-type']).toBe('application/json')
    expect(seen.headers['idempotency-key']).toBe('run1:node1')
    expect(seen.headers['x-test']).toBe('1')
  })

  it('keeps an idempotency key the config already sets', async () => {
    await httpRequest.execute(
      { url: `${server.base}/echo`, method: 'POST', headers: { 'idempotency-key': 'mine' } },
      makeCtx({ idempotencyKey: 'run1:node1' }),
    )
    expect(server.seen[0]?.headers['idempotency-key']).toBe('mine')
  })

  it('treats 503 and 429 as retryable', async () => {
    await expect(httpRequest.execute({ url: `${server.base}/busy` }, makeCtx())).rejects.toBeInstanceOf(RetryableError)
    await expect(httpRequest.execute({ url: `${server.base}/limited` }, makeCtx())).rejects.toBeInstanceOf(RetryableError)
  })

  it('fails other error statuses without retry', async () => {
    const error = await httpRequest.execute({ url: `${server.base}/missing` }, makeCtx()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RetryableError)
    expect((error as Error).message).toContain('HTTP 404: nope')
  })

  it('treats connection failures as retryable', async () => {
    const url = await closedPortUrl()
    await expect(httpRequest.execute({ url }, makeCtx())).rejects.toBeInstanceOf(RetryableError)
  })

  it('treats a timeout as retryable', async () => {
    await expect(httpRequest.execute({ url: `${server.base}/hang`, timeoutMs: 100 }, makeCtx())).rejects.toBeInstanceOf(
      RetryableError,
    )
  })

  it('does not follow redirects and does not retry them', async () => {
    const error = await httpRequest
      .execute({ url: `${server.base}/redirect`, method: 'POST' }, makeCtx())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RetryableError)
    expect((error as Error).message).toContain('HTTP 301: redirects are not followed')
    expect(server.seen.map((r) => r.url)).toEqual(['/redirect'])
  })

  it('fails when the response is larger than maxBytes', async () => {
    await expect(httpRequest.execute({ url: `${server.base}/big`, maxBytes: 1000 }, makeCtx())).rejects.toThrow(
      'larger than 1000 bytes',
    )
    await expect(httpRequest.execute({ url: `${server.base}/big` }, makeCtx())).resolves.toMatchObject({ status: 200 })
  })

  it('fails fast, without the url in the message, when the url or a header is malformed', async () => {
    for (const config of [
      { url: 'hooks.example.test/services/SECRETTOKEN' },
      { url: `${server.base}/json`, headers: { 'bad name': 'x' } },
      { url: `${server.base}/json`, headers: { 'X-Name': 'ñ한글' } },
    ]) {
      const error = await httpRequest.execute(config, makeCtx()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect((error as Error).message).not.toContain('SECRETTOKEN')
    }
    expect(server.seen).toHaveLength(0)
  })

  it('rejects non-http protocols', async () => {
    await expect(httpRequest.execute({ url: 'file:///etc/passwd' }, makeCtx())).rejects.toThrow('unsupported protocol')
  })

  it('names the failure code but never the url for connection failures', async () => {
    const url = await closedPortUrl()
    const error = await httpRequest.execute({ url }, makeCtx()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).toMatch(/^network error: \w+$/)
    expect((error as Error).message).not.toContain(url)
  })

  it('sends credentials from a connection without keeping them in the config', async () => {
    const ctx = makeCtx({ connections: { get: (id) => (id === 'api' ? 'tok123' : undefined) } })
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, ctx)
    await httpRequest.execute(
      { url: `${server.base}/json`, auth: { connection: 'api', header: 'X-Api-Key', scheme: 'None' } },
      ctx,
    )
    expect(server.seen[0]?.headers.authorization).toBe('Bearer tok123')
    expect(server.seen[1]?.headers['x-api-key']).toBe('tok123')
    await expect(
      httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'nope' } }, ctx),
    ).rejects.toThrow('unknown connection: nope')
  })

  it('makes no request in a dry run', async () => {
    const output = await httpRequest.execute({ url: `${server.base}/json` }, makeCtx({ dryRun: true }))
    expect(output).toEqual({ status: 0, headers: {}, body: null, dryRun: true })
    expect(server.seen).toHaveLength(0)
  })

  it('rejects a GET with a body before sending anything', async () => {
    await expect(httpRequest.execute({ url: `${server.base}/json`, body: { a: 1 } }, makeCtx())).rejects.toThrow(
      'GET requests cannot have a body',
    )
    expect(server.seen).toHaveLength(0)
  })
})

const MARKER = 'CONN-SECRET-MARKER'

function ctxFor(secret: string) {
  return makeCtx({ connections: { get: (id) => (id === 'api' ? secret : undefined) } })
}

function structured(auth: ConnectionAuth) {
  return ctxFor(encodeConnectionSecret(auth))
}

describe('http.request@1 with a plain secret', () => {
  const plain = ctxFor('tok123')

  it('sends Bearer by default', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api', scheme: 'Bearer' } }, plain)
    expect(server.seen[0]?.headers.authorization).toBe('Bearer tok123')
  })

  it('sends Basic with the secret as given', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api', scheme: 'Basic' } }, plain)
    expect(server.seen[0]?.headers.authorization).toBe('Basic tok123')
  })

  it('sends the bare secret for None, in a custom header', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api', scheme: 'None', header: 'X-Token' } }, plain)
    expect(server.seen[0]?.headers['x-token']).toBe('tok123')
    expect(server.seen[0]?.headers.authorization).toBeUndefined()
  })

  it('sends a custom header with the Bearer scheme', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api', header: 'X-Auth' } }, plain)
    expect(server.seen[0]?.headers['x-auth']).toBe('Bearer tok123')
  })

  it('does not touch the URL', async () => {
    await httpRequest.execute({ url: `${server.base}/echo-request?a=1`, auth: { connection: 'api' } }, plain)
    expect(server.seen[0]?.url).toBe('/echo-request?a=1')
  })

  it('treats a JSON object without rillAuth as a plain secret', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api', scheme: 'None' } }, ctxFor('{"a":1}'))
    expect(server.seen[0]?.headers.authorization).toBe('{"a":1}')
  })
})

describe('http.request@1 with a structured secret', () => {
  it('sends an API key in a header and replaces the node header of that name', async () => {
    const ctx = structured({ type: 'apiKey', in: 'header', name: 'X-Api-Key', value: MARKER })
    await httpRequest.execute({ url: `${server.base}/json`, headers: { 'x-api-key': 'from-config' }, auth: { connection: 'api' } }, ctx)
    expect(server.seen[0]?.headers['x-api-key']).toBe(MARKER)
  })

  it('adds an API key to a URL without a query', async () => {
    await httpRequest.execute({ url: `${server.base}/echo-request`, auth: { connection: 'api' } }, structured({ type: 'apiKey', in: 'query', name: 'api_key', value: MARKER }))
    expect(server.seen[0]?.url).toBe(`/echo-request?api_key=${MARKER}`)
  })

  it('keeps an existing query, replaces a same-name parameter and encodes special characters', async () => {
    const ctx = structured({ type: 'apiKey', in: 'query', name: 'key', value: 'a b&c=d/é' })
    await httpRequest.execute({ url: `${server.base}/echo-request?x=1&key=old&y=2`, auth: { connection: 'api' } }, ctx)
    expect(server.seen[0]?.url).toBe('/echo-request?x=1&y=2&key=a%20b%26c%3Dd%2F%C3%A9')
    const params = new URL(`http://h${server.seen[0]!.url}`).searchParams
    expect(params.get('key')).toBe('a b&c=d/é')
  })

  it('sends a Bearer token', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, structured({ type: 'bearer', token: MARKER }))
    expect(server.seen[0]?.headers.authorization).toBe(`Bearer ${MARKER}`)
  })

  it('sends a Basic login with a non-ASCII username and password', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, structured({ type: 'basic', username: '민수', password: 'pä:ss한글' }))
    const header = server.seen[0]!.headers.authorization!
    expect(header.startsWith('Basic ')).toBe(true)
    expect(Buffer.from(header.slice(6), 'base64').toString('utf8')).toBe('민수:pä:ss한글')
  })

  it('sends no credential for none and keeps the node headers', async () => {
    await httpRequest.execute({ url: `${server.base}/json`, headers: { 'X-Keep': '1' }, auth: { connection: 'api' } }, structured({ type: 'none' }))
    expect(server.seen[0]?.headers.authorization).toBeUndefined()
    expect(server.seen[0]?.headers['x-keep']).toBe('1')
  })

  it('ignores auth.header and auth.scheme of the node', async () => {
    const ctx = structured({ type: 'bearer', token: MARKER })
    await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api', header: 'X-Other', scheme: 'Basic' } }, ctx)
    expect(server.seen[0]?.headers.authorization).toBe(`Bearer ${MARKER}`)
    expect(server.seen[0]?.headers['x-other']).toBeUndefined()
  })

  it('fails a malformed structured value with a fixed message and sends nothing', async () => {
    for (const secret of [
      JSON.stringify({ rillAuth: 1, type: 'bearer', token: MARKER, extra: true }),
      JSON.stringify({ rillAuth: 2, type: 'bearer', token: MARKER }),
      JSON.stringify({ rillAuth: 1, type: 'apiKey', in: 'header', name: 'Host', value: MARKER }),
    ]) {
      const error = await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, ctxFor(secret)).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect((error as Error).message).toBe('connection api has a malformed auth value')
    }
    expect(server.seen).toHaveLength(0)
  })

  it('fails a header that cannot be sent without naming the value', async () => {
    const ctx = structured({ type: 'bearer', token: `${MARKER}한글` })
    const error = await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, ctx).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(MARKER)
    expect(server.seen).toHaveLength(0)
  })

  it('hides the components in an error text and in an echoed response', async () => {
    const cases: Array<[ConnectionAuth, string]> = [
      [{ type: 'apiKey', in: 'query', name: 'key', value: MARKER }, '/echo-error'],
      [{ type: 'bearer', token: MARKER }, '/echo-error'],
      [{ type: 'basic', username: 'someone', password: MARKER }, '/echo-error'],
    ]
    for (const [auth, route] of cases) {
      const error = await httpRequest.execute({ url: `${server.base}${route}`, auth: { connection: 'api' } }, structured(auth)).catch((e: unknown) => e)
      expect((error as Error).message).toContain('HTTP 400')
      expect((error as Error).message).not.toContain(MARKER)
      expect((error as Error).message).not.toContain(Buffer.from(`someone:${MARKER}`).toString('base64'))
    }
    const output = await httpRequest.execute({ url: `${server.base}/echo-request`, auth: { connection: 'api' } }, structured({ type: 'basic', username: 'someone', password: MARKER }))
    const scanned = JSON.stringify(output)
    expect(scanned).not.toContain(MARKER)
    expect(scanned).not.toContain(Buffer.from(`someone:${MARKER}`).toString('base64'))
    expect(scanned).toContain('<secret>')
  })

  it('leaves a response that does not echo anything unchanged', async () => {
    const output = await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, structured({ type: 'bearer', token: MARKER }))
    expect(output).toMatchObject({ status: 200, body: { hello: 'world' } })
  })

  it('makes no request in a dry run', async () => {
    const output = await httpRequest.execute({ url: `${server.base}/json`, auth: { connection: 'api' } }, makeCtx({ dryRun: true, connections: { get: () => encodeConnectionSecret({ type: 'bearer', token: MARKER }) } }))
    expect(output).toEqual({ status: 0, headers: {}, body: null, dryRun: true })
    expect(server.seen).toHaveLength(0)
  })
})
