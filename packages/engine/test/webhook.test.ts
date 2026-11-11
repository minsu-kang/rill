import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebhookHub, WebhookRuntime, type WebhookRequest } from '../src/triggers/webhook'
import { ManualClock } from './manual-clock'
import { createHost } from './trigger-helpers'

let hub: WebhookHub
let base: string
let received: WebhookRequest[]

beforeEach(async () => {
  hub = new WebhookHub(0)
  const port = await hub.listen()
  base = `http://127.0.0.1:${port}`
  received = []
})

afterEach(async () => {
  await hub.close()
})

function register(owner: string, path: string, secret?: string, method = 'POST') {
  hub.register(owner, { method, path, secret }, (request) => {
    received.push(request)
    return { runId: `run-${received.length}` }
  })
}

function rawRequest(path: string, headers: Record<string, string>, method = 'POST'): Promise<number> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end('{}')
  })
}

describe('WebhookHub', () => {
  it('binds to 127.0.0.1 and reports its port', async () => {
    expect(hub.port).toBeGreaterThan(0)
    expect(await hub.listen()).toBe(hub.port)
  })

  it('is safe to listen on concurrently: one server, one port', async () => {
    const other = new WebhookHub(0)
    const ports = await Promise.all([other.listen(), other.listen(), other.listen()])
    expect(new Set(ports).size).toBe(1)
    expect(other.port).toBe(ports[0])
    await other.close()
    expect(other.port).toBeUndefined()
  })

  it('accepts a JSON body and passes query, headers and body to the handler', async () => {
    register('w1', '/hooks/receipts')
    const response = await fetch(`${base}/hooks/receipts?src=scanner&n=2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      body: JSON.stringify({ amount: 12.5 }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ runId: 'run-1' })
    expect(received[0]).toMatchObject({
      method: 'POST',
      path: '/hooks/receipts',
      query: { src: 'scanner', n: '2' },
      body: { amount: 12.5 },
    })
    expect(received[0]?.headers['x-custom']).toBe('yes')
  })

  it('passes text bodies through and uses null for an empty body', async () => {
    register('w1', '/text')
    await fetch(`${base}/text`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' })
    await fetch(`${base}/text`, { method: 'POST' })
    expect(received.map((r) => r.body)).toEqual(['hello', null])
  })

  it('never exposes authorization, cookie or secret headers to the workflow', async () => {
    register('w1', '/secure', 'topsecret')
    await fetch(`${base}/secure`, {
      method: 'POST',
      headers: { authorization: 'Bearer abc', cookie: 'sid=1', 'x-rill-secret': 'topsecret', 'x-keep': 'ok' },
    })
    expect(Object.keys(received[0]!.headers)).not.toContain('authorization')
    expect(Object.keys(received[0]!.headers)).not.toContain('cookie')
    expect(Object.keys(received[0]!.headers)).not.toContain('x-rill-secret')
    expect(JSON.stringify(received[0])).not.toContain('topsecret')
    expect(received[0]?.headers['x-keep']).toBe('ok')
  })

  it('requires the shared secret when the route has one', async () => {
    register('w1', '/secure', 'topsecret')
    expect((await fetch(`${base}/secure`, { method: 'POST' })).status).toBe(401)
    expect(
      (await fetch(`${base}/secure`, { method: 'POST', headers: { 'x-rill-secret': 'wrong' } })).status,
    ).toBe(401)
    expect(
      (await fetch(`${base}/secure`, { method: 'POST', headers: { 'x-rill-secret': 'topsecret' } })).status,
    ).toBe(202)
    expect(received).toHaveLength(1)
  })

  it('answers 404 for unknown paths and methods', async () => {
    register('w1', '/known')
    expect((await fetch(`${base}/unknown`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/known`, { method: 'GET' })).status).toBe(404)
    expect(received).toHaveLength(0)
  })

  it('does not route a double-slash target to a shorter path', async () => {
    register('w1', '/a')
    expect(await rawRequest('//a', {})).toBe(404)
    expect(await rawRequest('/%2e%2e/a', {})).toBe(404)
    expect(await rawRequest('/a', {})).toBe(202)
    expect(received).toHaveLength(1)
  })

  it('serves GET routes', async () => {
    register('w1', '/ping', undefined, 'GET')
    const response = await fetch(`${base}/ping?x=1`)
    expect(response.status).toBe(202)
    expect(received[0]).toMatchObject({ method: 'GET', query: { x: '1' }, body: null })
  })

  it('rejects oversized bodies and invalid JSON', async () => {
    register('w1', '/hooks')
    const large = await fetch(`${base}/hooks`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) })
    expect(large.status).toBe(413)
    const invalid = await fetch(`${base}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(invalid.status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('rejects requests whose Host header is not local (DNS rebinding)', async () => {
    register('w1', '/hooks')
    expect(await rawRequest('/hooks', { host: 'evil.example' })).toBe(403)
    expect(received).toHaveLength(0)
    expect(await rawRequest('/hooks', { host: `localhost:${hub.port}` })).toBe(202)
  })

  it('keeps web pages from starting a route that has no secret', async () => {
    register('open', '/open')
    register('guarded', '/guarded', 'topsecret')
    expect(await rawRequest('/open', { origin: 'https://evil.example', 'content-type': 'text/plain' })).toBe(403)
    expect(await rawRequest('/open', { 'sec-fetch-site': 'cross-site' })).toBe(403)
    expect(await rawRequest('/open', { 'sec-fetch-site': 'none' })).toBe(202)
    expect(await rawRequest('/guarded', { origin: 'https://evil.example', 'x-rill-secret': 'topsecret' })).toBe(202)
    expect(received).toHaveLength(2)
  })

  it('hides handler failures behind a generic 500', async () => {
    hub.register('w1', { method: 'POST', path: '/boom' }, () => {
      throw new Error('database password is hunter2')
    })
    const response = await fetch(`${base}/boom`, { method: 'POST' })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('hunter2')
  })

  it('does not deliver a request whose route was removed while its body was still arriving', async () => {
    register('w1', '/slow')
    const url = new URL(base)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: url.hostname, port: url.port, path: '/slow', method: 'POST', headers: { 'content-type': 'text/plain' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.write('part one')
      setTimeout(() => {
        hub.unregister('w1')
        req.end(' part two')
      }, 50)
    })
    expect(status).toBe(404)
    expect(received).toHaveLength(0)
  })

  it('refuses duplicate routes and frees them on unregister', async () => {
    register('w1', '/dup')
    expect(() => register('w2', '/dup')).toThrow('webhook route already in use: POST /dup')
    hub.unregister('w1')
    register('w2', '/dup')
    expect((await fetch(`${base}/dup`, { method: 'POST' })).status).toBe(202)
  })

  it('stops serving after close', async () => {
    register('w1', '/hooks')
    await hub.close()
    await expect(fetch(`${base}/hooks`, { method: 'POST' })).rejects.toThrow()
    expect(hub.port).toBeUndefined()
  })
})

describe('WebhookRuntime', () => {
  it('fires the workflow with the request and unregisters on stop', async () => {
    const h = createHost(new ManualClock(0))
    const runtime = new WebhookRuntime(h.workflowId, { path: '/hooks/a' }, undefined, hub, h.host)
    const response = await fetch(`${base}/hooks/a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
    expect(response.status).toBe(202)
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0]?.payload).toMatchObject({ method: 'POST', path: '/hooks/a', body: { a: 1 } })
    expect(await response.json()).toEqual({ runId: h.fired[0]?.runId })
    runtime.stop()
    expect((await fetch(`${base}/hooks/a`, { method: 'POST' })).status).toBe(404)
  })

  it('reports a failing fire as a trigger error and answers 500', async () => {
    const h = createHost(new ManualClock(0))
    const runtime = new WebhookRuntime(h.workflowId, { path: '/hooks/a' }, undefined, hub, h.host)
    h.failFires(true)
    const response = await fetch(`${base}/hooks/a`, { method: 'POST' })
    expect(response.status).toBe(500)
    expect(h.events).toEqual([{ type: 'trigger.error', workflowId: h.workflowId, error: 'fire failed' }])
    runtime.stop()
  })
})
