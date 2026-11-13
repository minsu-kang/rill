import { createCoreRegistry } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionSecrets } from '../src/explain'
import { GOOD, allTables, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { isolateKeyEnvironment } from './llm-env'

const GOOGLE_TOKEN = 'ya29.TOKENMARKER0123456789'
const MICROSOFT_TOKEN = 'eyJTOKENMARKER0123456789.payload.sig'
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const dirOf = useTempDir()
useCleanups()
isolateKeyEnvironment()

const realFetch = globalThis.fetch
const HOSTS = ['https://sheets.googleapis.com/', 'https://graph.microsoft.com/']

function stubApi(respond: (call: { url: string; authorization: string | null }) => Response): void {
  vi.stubGlobal('fetch', (input: URL | string, init?: RequestInit) => {
    const url = String(input)
    if (!HOSTS.some((host) => url.startsWith(host))) return realFetch(input, init)
    return Promise.resolve(respond({ url, authorization: new Headers(init?.headers).get('authorization') }))
  })
}

const sheetsNode = { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'sheets', spreadsheetId: SHEET, values: ['a', 1] } }
const excelNode = { id: 'n1', type: 'microsoft.excel.append@1', config: { connection: 'drive', filePath: 'Receipts/ledger.xlsx', table: 'Expenses', values: ['a', 1] } }
const connections = (name: string) => ({ sheets: GOOGLE_TOKEN, drive: MICROSOFT_TOKEN })[name as 'sheets' | 'drive']
const resolver = { get: connections, kindOf: (name: string) => ({ sheets: 'google', drive: 'microsoft' })[name as 'sheets' | 'drive'] }

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connectionSecrets with an access token', () => {
  const workflow = { schemaVersion: 1 as const, name: 'w', nodes: [sheetsNode], edges: [] }

  it('adds the token of the connection that the step names', () => {
    expect(connectionSecrets(workflow, [], createCoreRegistry(), resolver)).toEqual([GOOGLE_TOKEN])
  })

  it('adds nothing for a connection that is not configured', () => {
    expect(connectionSecrets(workflow, [], createCoreRegistry(), { get: () => undefined })).toEqual([])
  })
})

describe('a failed run of a spreadsheet node', () => {
  const cases: Array<[string, typeof sheetsNode | typeof excelNode, string, number, string]> = [
    ['Google Sheets after a 400 that echoes the token', sheetsNode, GOOGLE_TOKEN, 400, 'HTTP 400: the data was not accepted'],
    ['Google Sheets after a 401', sheetsNode, GOOGLE_TOKEN, 401, 'HTTP 401: the sign-in is no longer valid, reconnect the account'],
    ['Excel after a 403 that echoes the token', excelNode, MICROSOFT_TOKEN, 403, 'HTTP 403: the account may not change this file'],
    ['Excel after a 404', excelNode, MICROSOFT_TOKEN, 404, 'HTTP 404: the file, sheet or table was not found'],
  ]

  for (const [label, node, token, status, text] of cases) {
    it(`never exposes the token after ${label}`, async () => {
      stubApi(({ authorization }) => new Response(JSON.stringify({ error: { message: `bad ${authorization} ${token}` }, received: token }), { status, headers: { 'content-type': 'application/json' } }))
      const env = await startEnv(dirOf.get(), [{ data: GOOD }], { connections: resolver })
      const runId = await env.run([node])
      const detail = await env.client.request('getRun', { runId })
      expect(detail.run.status).toBe('failed')
      expect(detail.steps[0]!.error).toBe(text)
      const mark = env.frames.length
      const result = await env.client.request('explainRun', { runId })
      const everything = [JSON.stringify(detail), JSON.stringify(allTables(env.db)), JSON.stringify(env.provider.requests), JSON.stringify(result), ...env.frames.slice(0, mark), ...env.frames.slice(mark), ...env.logs].join('\n')
      expect(everything).not.toContain('TOKENMARKER')
      expect(everything).not.toContain(token)
    })
  }

  it('gives the model the signal of a rejected sign-in as a fact', async () => {
    stubApi(() => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
    const env = await startEnv(dirOf.get(), [{ data: GOOD }], { connections: resolver })
    const runId = await env.run([sheetsNode])
    await env.client.request('explainRun', { runId })
    expect(JSON.stringify(env.provider.requests)).toContain('n1: http_status_401_403')
  })

  it('records only the fixed text of a server error and masks a token that a later step would echo', async () => {
    stubApi(({ authorization }) => new Response(`down ${authorization ?? ''}`, { status: 503 }))
    const env = await startEnv(dirOf.get(), [], { connections: resolver })
    const runId = await env.run([excelNode])
    const detail = await env.client.request('getRun', { runId })
    expect(detail.steps[0]!.error).toBe('HTTP 503')
    expect(JSON.stringify(detail)).not.toContain('TOKENMARKER')
  })

  it('appends a row and records the output without the token even when the answer echoes it', async () => {
    const seen: Array<string | null> = []
    stubApi(({ authorization }) => {
      seen.push(authorization)
      return new Response(JSON.stringify({ updates: { updatedRange: `Sheet1!${GOOGLE_TOKEN}` } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const env = await startEnv(dirOf.get(), [], { connections: resolver })
    const runId = await env.run([sheetsNode])
    const detail = await env.client.request('getRun', { runId })
    expect(detail.run.status).toBe('succeeded')
    expect(seen).toEqual([`Bearer ${GOOGLE_TOKEN}`])
    expect(JSON.stringify([detail, allTables(env.db)])).not.toContain('TOKENMARKER')
  })
})
