import { createCoreRegistry } from '@rill/nodes-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { parseConnections } from '../src/cli-config'
import { Engine } from '../src/engine'
import { linearWorkflow } from './helpers'

const GOOGLE_TOKEN = 'ya29.TOKENMARKER0123456789'
const MICROSOFT_TOKEN = 'eyJTOKENMARKER0123456789.payload.sig'
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const trigger = { id: 't1', type: 'trigger.manual@1' }

const secrets: Record<string, { secret: string; kind: string }> = {
  g: { secret: GOOGLE_TOKEN, kind: 'google' },
  ms: { secret: MICROSOFT_TOKEN, kind: 'microsoft' },
  api: { secret: 'plain-api-key', kind: 'http' },
}

function engineWith(kinds: boolean) {
  const db = Db.open(':memory:')
  const engine = new Engine({
    db,
    registry: createCoreRegistry(),
    sleep: async () => {},
    random: () => 1,
    connections: { get: (id) => secrets[id]?.secret, ...(kinds ? { kindOf: (id: string) => secrets[id]?.kind } : {}) },
  })
  return engine
}

async function run(engine: Engine, step: Record<string, unknown>) {
  const id = engine.deploy(linearWorkflow([trigger, { id: 'n1', type: 'http.request@1', config: step }]))
  return { result: await engine.startRun(id) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('http.request through the real executor with an account connection', () => {
  for (const [name, label] of [['g', 'Google'], ['ms', 'Microsoft']] as const) {
    it(`fails the run and sends nothing when the step names a ${label} connection`, async () => {
      const fetchSpy = vi.fn(async () => new Response('ok'))
      vi.stubGlobal('fetch', fetchSpy)
      const { result } = await run(engineWith(true), { url: 'https://collect.example.test/ingest', method: 'POST', body: { a: 1 }, auth: { connection: name } })
      expect(result.status).toBe('failed')
      expect(result.error).toBe(`node n1 failed: connection ${name} is a ${label} connection`)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('TOKENMARKER')
    })
  }

  it('records the refusal without the token in any step record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')))
    const engine = engineWith(true)
    const { result } = await run(engine, { url: 'https://collect.example.test/ingest', auth: { connection: 'g' } })
    const detail = JSON.stringify([engine.store.getRun(result.runId), engine.store.listStepDetails(result.runId)])
    expect(detail).toContain('is a Google connection')
    expect(detail).not.toContain('TOKENMARKER')
  })

  it('still sends with a connection of kind http', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = await run(engineWith(true), { url: 'https://api.example.test/x', auth: { connection: 'api' } })
    expect(result.status).toBe('succeeded')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('cannot tell the kind when the resolver has none, and then sends', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = await run(engineWith(false), { url: 'https://api.example.test/x', auth: { connection: 'g' } })
    expect(result.status).toBe('succeeded')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('the spreadsheet nodes through the real executor', () => {
  it('appends a row to Google Sheets with the token of the connection and records no token', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = []
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: String(init?.body) })
      return new Response(JSON.stringify({ updates: { updatedRange: `Sheet1!${GOOGLE_TOKEN}` } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const engine = engineWith(true)
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'g', spreadsheetId: SHEET, values: ['a', 2, true] } }]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('succeeded')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.auth).toBe(`Bearer ${GOOGLE_TOKEN}`)
    expect(seen[0]!.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')).toBe(true)
    expect(JSON.stringify([engine.store.getRun(result.runId), engine.store.listStepDetails(result.runId)])).not.toContain('TOKENMARKER')
  })

  it('fails a Google step that names a Microsoft connection without sending', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    const engine = engineWith(true)
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'ms', spreadsheetId: SHEET, values: ['a'] } }]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('node n1 failed: connection ms is a microsoft connection, not a google connection')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('retries a server error of Excel and then gives up with a fixed text', async () => {
    const fetchSpy = vi.fn(async () => new Response(`down ${MICROSOFT_TOKEN}`, { status: 503 }))
    vi.stubGlobal('fetch', fetchSpy)
    const engine = engineWith(true)
    const id = engine.deploy(
      linearWorkflow([
        trigger,
        { id: 'n1', type: 'microsoft.excel.append@1', config: { connection: 'ms', filePath: 'Receipts/ledger.xlsx', table: 'Expenses', values: ['a'] }, retry: { maxAttempts: 2 } },
      ]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.error).toBe('node n1 failed: HTTP 503')
  })
})

describe('a connections file with account connections through the real executor', () => {
  const file = JSON.stringify({
    sheets: { secret: GOOGLE_TOKEN, kind: 'google' },
    drive: { secret: MICROSOFT_TOKEN, kind: 'microsoft' },
    api: { secret: 'plain-api-key', kind: 'http' },
    bare: GOOGLE_TOKEN,
    stripe: 'sk_live_ABCDEF0123456789',
  })

  function engineFromFile() {
    const { resolver, planConnections } = parseConnections(file)
    return new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), sleep: async () => {}, random: () => 1, connections: resolver, planConnections })
  }

  for (const [name, label] of [['sheets', 'Google'], ['drive', 'Microsoft']] as const) {
    it(`refuses a plain http.request that names the ${label} entry of the file before any request`, async () => {
      const fetchSpy = vi.fn(async () => new Response('ok'))
      vi.stubGlobal('fetch', fetchSpy)
      const { result } = await run(engineFromFile(), { url: 'https://collect.example.test/ingest', method: 'POST', body: { a: 1 }, auth: { connection: name } })
      expect(result.status).toBe('failed')
      expect(result.error).toBe(`node n1 failed: connection ${name} is a ${label} connection`)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('TOKENMARKER')
    })
  }

  it('still sends through the http entry of the file and through an entry without a kind', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await run(engineFromFile(), { url: 'https://api.example.test/x', auth: { connection: 'api' } })).result.status).toBe('succeeded')
    expect((await run(engineFromFile(), { url: 'https://api.example.test/x', auth: { connection: 'bare' } })).result.status).toBe('succeeded')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('refuses a spreadsheet node that names an entry without a kind and sends nothing', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const engine = engineFromFile()
    for (const [type, extra, kind] of [
      ['google.sheets.append@1', { spreadsheetId: SHEET }, 'google'],
      ['microsoft.excel.append@1', { filePath: 'Receipts/ledger.xlsx', table: 'Expenses' }, 'microsoft'],
    ] as const) {
      for (const name of ['bare', 'stripe']) {
        const id = engine.deploy(linearWorkflow([trigger, { id: 'n1', type, config: { connection: name, ...extra, values: ['a'] } }]))
        const result = await engine.startRun(id)
        expect(result.status).toBe('failed')
        expect(result.error).toBe(`node n1 failed: connection ${name} has no kind, give it the kind ${kind}`)
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('runs the spreadsheet nodes with the entries of the file and refuses the entry of another kind', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      seen.push(`${String(input).split('?')[0]} ${new Headers(init?.headers).get('authorization')}`)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const engine = engineFromFile()
    const ok = engine.deploy(
      linearWorkflow([
        trigger,
        { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'sheets', spreadsheetId: SHEET, values: ['a'] } },
        { id: 'n2', type: 'microsoft.excel.append@1', config: { connection: 'drive', filePath: 'Receipts/ledger.xlsx', table: 'Expenses', values: ['a'] } },
      ]),
    )
    expect((await engine.startRun(ok)).status).toBe('succeeded')
    expect(seen).toEqual([
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values/Sheet1:append Bearer ${GOOGLE_TOKEN}`,
      `https://graph.microsoft.com/v1.0/me/drive/root:/Receipts/ledger.xlsx:/workbook/tables/Expenses/rows/add Bearer ${MICROSOFT_TOKEN}`,
    ])
    seen.length = 0
    const wrong = engine.deploy(
      linearWorkflow([trigger, { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'api', spreadsheetId: SHEET, values: ['a'] } }]),
    )
    const result = await engine.startRun(wrong)
    expect(result.error).toBe('node n1 failed: connection api is a http connection, not a google connection')
    expect(seen).toEqual([])
  })
})
