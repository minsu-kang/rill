import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCoreRegistry, encodeConnectionSecret, type ConnectionAuth } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectionSecrets } from '../src/explain'
import { GOOD, allTables, http, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { isolateKeyEnvironment } from './llm-env'

const MARKER = 'CONN-SECRET-MARKER'
const LOGIN = Buffer.from(`someone:${MARKER}`).toString('base64')
const dirOf = useTempDir()
useCleanups()
isolateKeyEnvironment()

let echo: Server
let base = ''

beforeEach(async () => {
  echo = createServer((req, res) => {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-echo', String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''))
    res.end(JSON.stringify({ error: 'unauthorized', url: req.url, authorization: req.headers.authorization ?? null, key: req.headers['x-api-key'] ?? null }))
  })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`
})

afterEach(async () => {
  echo.closeAllConnections()
  await new Promise<void>((resolve) => echo.close(() => resolve()))
})

const AUTHS: Record<string, ConnectionAuth> = {
  'api key in a header': { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: MARKER },
  'api key in the query': { type: 'apiKey', in: 'query', name: 'api_key', value: MARKER },
  'a bearer token': { type: 'bearer', token: MARKER },
  'a basic login': { type: 'basic', username: 'someone', password: MARKER },
}

describe('connectionSecrets with a structured secret', () => {
  const workflow = { schemaVersion: 1 as const, name: 'w', nodes: [{ id: 'n1', type: 'http.request@1', config: { url: 'https://a.example.com', auth: { connection: 'api' } } }], edges: [] }

  it('adds the components and the base64 login next to the whole value', () => {
    const secret = encodeConnectionSecret({ type: 'basic', username: 'someone', password: MARKER })
    const found = connectionSecrets(workflow, [], createCoreRegistry(), { get: () => secret })
    expect(found).toEqual(expect.arrayContaining([secret, MARKER, `someone:${MARKER}`, LOGIN]))
    expect(found).not.toContain('someone')
  })

  it('adds the token and the key value', () => {
    for (const auth of [AUTHS['a bearer token']!, AUTHS['api key in the query']!]) {
      const secret = encodeConnectionSecret(auth)
      expect(connectionSecrets(workflow, [], createCoreRegistry(), { get: () => secret })).toEqual([secret, MARKER])
    }
  })
})

describe('a failed run with a structured connection', () => {
  for (const [label, auth] of Object.entries(AUTHS)) {
    it(`never exposes ${label} in a record, an event, a log, a result or the provider request`, async () => {
      const secret = encodeConnectionSecret(auth)
      const env = await startEnv(dirOf.get(), [{ data: GOOD }], { connections: { get: (name) => (name === 'api' ? secret : undefined) } })
      const node = http(base, '/anything?x=1', {}, { auth: { connection: 'api' } })
      const runId = await env.run([node])
      const detail = await env.client.request('getRun', { runId })
      expect(detail.run.status).toBe('failed')
      expect(detail.steps[0]!.error).toContain('HTTP 401')

      const mark = env.frames.length
      const result = await env.client.request('explainRun', { runId })
      const everything = [
        JSON.stringify(detail),
        JSON.stringify(allTables(env.db)),
        JSON.stringify(env.provider.requests),
        JSON.stringify(result),
        ...env.frames.slice(0, mark),
        ...env.frames.slice(mark),
        ...env.logs,
      ].join('\n')
      for (const hidden of [MARKER, LOGIN, secret, JSON.stringify(secret).slice(1, -1), `someone:${MARKER}`]) expect(everything).not.toContain(hidden)
    })
  }

  it('does not show an API key that sits in the query when a step shows the url', async () => {
    const secret = encodeConnectionSecret(AUTHS['api key in the query']!)
    const env = await startEnv(dirOf.get(), [{ data: GOOD }], { connections: { get: (name) => (name === 'api' ? secret : undefined) } })
    const runId = await env.run([http(base, '/anything', {}, { auth: { connection: 'api' } })])
    await env.client.request('explainRun', { runId })
    const sent = JSON.stringify(env.provider.requests[0])
    expect(sent).not.toContain(MARKER)
    expect(sent).not.toContain('api_key=CONN')
  })
})
