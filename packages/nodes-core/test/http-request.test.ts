import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RetryableError, createCoreRegistry } from '../src/index'
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
