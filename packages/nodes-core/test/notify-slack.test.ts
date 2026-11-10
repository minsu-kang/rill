import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RetryableError, createCoreRegistry } from '../src/index'
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
})
