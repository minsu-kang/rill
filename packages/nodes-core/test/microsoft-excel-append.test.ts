import Value from 'typebox/value'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetryableError, createCoreRegistry, encodeSlackBotSecret, fieldRoles } from '../src/index'
import { microsoftExcelAppend } from '../src/nodes/microsoft-excel-append'
import { jsonResponse, stubFetch, stubFetchFailure, textResponse } from './fetch-stub'
import { makeCtx } from './helpers'

const TOKEN = 'eyJTOKENMARKER0123456789.payload.sig'
const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive/root:'

const ctxWith = (secret: string | undefined = TOKEN, kind: string | undefined = 'microsoft') =>
  makeCtx({ connections: { get: (id) => (id === 'ms' ? secret : undefined), kindOf: (id) => (id === 'ms' ? kind : undefined) } })

const config = (extra: Record<string, unknown> = {}) => ({ connection: 'ms', filePath: 'Receipts/ledger.xlsx', table: 'Expenses', values: ['2026-11-12', 12.5, true, null, 'Cafe'], ...extra })

const added = () => jsonResponse({ index: 4, values: [['2026-11-12']] }, 201)

const run = (cfg: Record<string, unknown>, ctx = ctxWith()) => microsoftExcelAppend.execute(cfg, ctx)
const fail = (cfg: Record<string, unknown>, ctx = ctxWith()) => run(cfg, ctx).catch((error: unknown) => error as Error)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('microsoft.excel.append@1 definition', () => {
  it('is a registered external node with a recipient file and a connection', () => {
    expect(microsoftExcelAppend.type).toBe('microsoft.excel.append@1')
    expect(microsoftExcelAppend.sideEffect).toBe('external')
    expect(createCoreRegistry().has('microsoft.excel.append@1')).toBe(true)
    expect(Object.fromEntries(fieldRoles(microsoftExcelAppend).map(({ pointer, role }) => [pointer, role]))).toEqual({ '/connection': 'connection', '/filePath': 'recipient' })
  })

  it('says what it needs, what it does to formulas and that a resumed run can add the row twice', () => {
    const text = microsoftExcelAppend.description
    expect(text).toMatch(/^Appends one row to an Excel table/)
    expect(text).toContain('microsoft connection')
    expect(text).toContain('.xlsx')
    expect(text).toContain('table')
    expect(text).toContain('twice')
    expect(text).toContain('A retry after a server error, a timeout or a network error can do the same.')
    expect(text).toContain('single quote')
  })

  it('has an output of appended only', () => {
    expect(Value.Check(microsoftExcelAppend.outputSchema, { appended: true })).toBe(true)
    expect(Value.Check(microsoftExcelAppend.outputSchema, { appended: 1 })).toBe(false)
  })
})

describe('microsoft.excel.append@1 config limits', () => {
  const ok = (cfg: Record<string, unknown>) => Value.Check(microsoftExcelAppend.configSchema, cfg)

  it('accepts the plain form and every limit edge', () => {
    expect(ok(config())).toBe(true)
    expect(ok(config({ filePath: 'a.xlsx' }))).toBe(true)
    expect(ok(config({ filePath: 'Budget 2026/Q1/ledger.XLSX' }))).toBe(true)
    expect(ok(config({ filePath: `${'a'.repeat(395)}.xlsx` }))).toBe(true)
    expect(ok(config({ filePath: '영수증/장부.xlsx', table: '지출' }))).toBe(true)
    expect(ok(config({ table: 'T'.repeat(255) }))).toBe(true)
    expect(ok(config({ table: 'Table_1.v2' }))).toBe(true)
    expect(ok(config({ values: Array.from({ length: 50 }, () => 'v') }))).toBe(true)
    expect(ok(config({ values: ['x'.repeat(2000)] }))).toBe(true)
  })

  it('rejects a file path that is empty, too long, absolute, not .xlsx or that climbs out', () => {
    const bad = [
      '',
      '.xlsx',
      `${'a'.repeat(396)}.xlsx`,
      '/Receipts/ledger.xlsx',
      '../ledger.xlsx',
      'Receipts/../ledger.xlsx',
      'Receipts/..',
      './ledger.xlsx',
      'Receipts/./ledger.xlsx',
      'Receipts//ledger.xlsx',
      'ledger.xls',
      'ledger.xlsx.txt',
      'ledger.xlsxx',
      'Receipts/',
      'Receipts%2F..%2Fledger.xlsx',
      'Receipts%2Fledger.xlsx',
      'a\\b.xlsx',
      'a\nb.xlsx',
      'a\u0000b.xlsx',
      'a‮b.xlsx',
      'a​b.xlsx',
      'a?b.xlsx',
      'a#b.xlsx',
      'a:b.xlsx',
      'a*b.xlsx',
      'a"b.xlsx',
      'a<b.xlsx',
      'a|b.xlsx',
    ]
    for (const filePath of bad) expect(ok(config({ filePath })), JSON.stringify(filePath)).toBe(false)
  })

  it('rejects a table name that is empty, too long, starts oddly or has path characters', () => {
    for (const table of ['', 'T'.repeat(256), '.', '..', '.hidden', '1st', 'a/b', 'a\\b', 'a?b', 'a#b', 'a%2Fb', 'a\nb', 'a\u0000b']) {
      expect(ok(config({ table })), JSON.stringify(table)).toBe(false)
    }
  })

  it('rejects empty and too long rows, bad cells, long text and unknown keys', () => {
    expect(ok(config({ values: [] }))).toBe(false)
    expect(ok(config({ values: Array.from({ length: 51 }, () => 'v') }))).toBe(false)
    expect(ok(config({ values: ['x'.repeat(2001)] }))).toBe(false)
    expect(ok(config({ values: [{ a: 1 }] }))).toBe(false)
    expect(ok(config({ values: [['nested']] }))).toBe(false)
    expect(ok(config({ extra: 1 }))).toBe(false)
    expect(ok({ connection: 'ms', table: 'T', values: ['a'] })).toBe(false)
    expect(ok({ connection: 'ms', filePath: 'a.xlsx', values: ['a'] })).toBe(false)
  })

  it('refuses a bad value in execute itself, before any request', async () => {
    const seen = stubFetch(added())
    for (const cfg of [
      config({ filePath: '../x.xlsx' }),
      config({ filePath: 'a/../../x.xlsx' }),
      config({ filePath: '/x.xlsx' }),
      config({ filePath: 'x.csv' }),
      config({ filePath: 'a%2F..%2Fb.xlsx' }),
      config({ filePath: 'a\u0007b.xlsx' }),
      config({ table: '..' }),
      config({ table: 'a/b' }),
      config({ values: [] }),
      config({ values: Array.from({ length: 51 }, () => 'v') }),
    ]) {
      const error = await fail(cfg)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect((error as Error).message).toMatch(/^invalid config: \//)
    }
    expect(seen).toHaveLength(0)
  })
})

describe('microsoft.excel.append@1 request', () => {
  it('posts one row to the table of the workbook with a bearer token', async () => {
    const seen = stubFetch(added())
    expect(await run(config())).toEqual({ appended: true })
    expect(seen).toHaveLength(1)
    const call = seen[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`${GRAPH}/Receipts/ledger.xlsx:/workbook/tables/Expenses/rows/add`)
    expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(call.headers['content-type']).toBe('application/json')
    expect(JSON.parse(call.body!)).toEqual({ values: [['2026-11-12', 12.5, true, '', 'Cafe']] })
  })

  it('encodes every path segment on its own and keeps the slashes between folders', async () => {
    const seen = stubFetch(added())
    await run(config({ filePath: 'Budget 2026/Q1 & Q2/ledger (final).xlsx', table: 'Table 1' }))
    await run(config({ filePath: '영수증/장부.xlsx', table: '지출' }))
    expect(seen.map((call) => call.url)).toEqual([
      `${GRAPH}/Budget%202026/Q1%20%26%20Q2/ledger%20%28final%29.xlsx:/workbook/tables/Table%201/rows/add`,
      `${GRAPH}/${encodeURIComponent('영수증')}/${encodeURIComponent('장부')}.xlsx:/workbook/tables/${encodeURIComponent('지출')}/rows/add`,
    ])
  })

  it('keeps the host and the fixed path parts whatever the path and table hold', async () => {
    const seen = stubFetch(added())
    await run(config({ filePath: 'a/b/c.xlsx', table: 'T.1' }))
    const url = new URL(seen[0]!.url)
    expect(url.origin).toBe('https://graph.microsoft.com')
    expect(url.pathname.startsWith('/v1.0/me/drive/root:/')).toBe(true)
    expect(url.pathname.endsWith(':/workbook/tables/T.1/rows/add')).toBe(true)
    expect(url.search).toBe('')
  })

  it('puts a single quote before a text that Excel could read as a formula and leaves numbers alone', async () => {
    const seen = stubFetch(added())
    await run(config({ values: ['=HYPERLINK("http://evil.test","x")', '+1+1', '@SUM(A1)', '-cmd', '\t=x', '\r=x', '-5', '+3.5', '1e3', '.5', 'plain', '', 7, false, null, "'=x"] }))
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      values: [["'=HYPERLINK(\"http://evil.test\",\"x\")", "'+1+1", "'@SUM(A1)", "'-cmd", "'\t=x", "'\r=x", '-5', '+3.5', '1e3', '.5', 'plain', '', 7, false, '', "'=x"]],
    })
  })

  it('reads the token again for every call', async () => {
    const seen = stubFetch(added())
    let current = TOKEN
    const ctx = makeCtx({ connections: { get: () => current, kindOf: () => 'microsoft' } })
    await run(config(), ctx)
    current = 'eyJREFRESHED0123456789.payload.sig'
    await run(config(), ctx)
    expect(seen.map((call) => call.headers['authorization'])).toEqual([`Bearer ${TOKEN}`, 'Bearer eyJREFRESHED0123456789.payload.sig'])
  })

  it('does not follow a redirect', async () => {
    const seen = stubFetch(new Response('', { status: 302, headers: { location: 'https://evil.test/' } }))
    const error = await fail(config())
    expect((error as Error).message).toBe('HTTP 302: redirects are not followed')
    expect(seen).toHaveLength(1)
  })
})

describe('microsoft.excel.append@1 answers', () => {
  const STATUS: [number, string][] = [
    [400, 'HTTP 400: the data was not accepted'],
    [401, 'HTTP 401: the sign-in is no longer valid, reconnect the account'],
    [403, 'HTTP 403: the account may not change this file'],
    [404, 'HTTP 404: the file, sheet or table was not found'],
    [409, 'HTTP 409: the request was not accepted'],
    [423, 'HTTP 423: the request was not accepted'],
    [499, 'HTTP 499: the request was not accepted'],
  ]

  for (const [status, message] of STATUS) {
    it(`maps ${status} to a fixed reason that is not retried`, async () => {
      stubFetch(jsonResponse({ error: { code: 'itemNotFound', message: 'SECRET-BODY-TEXT' } }, status))
      const error = await fail(config())
      expect((error as Error).message).toBe(message)
      expect(error).not.toBeInstanceOf(RetryableError)
    })
  }

  it('never shows the body of an error answer, even when it echoes the credentials', async () => {
    stubFetch((call) => jsonResponse({ error: { message: `bad ${call.headers['authorization']} and ${TOKEN}` } }, 401))
    const error = await fail(config())
    expect((error as Error).message).toBe('HTTP 401: the sign-in is no longer valid, reconnect the account')
    expect((error as Error).stack ?? '').not.toContain('TOKENMARKER')
  })

  it('gives the request 15 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      stubFetch(added())
      await run(config())
      expect(timeout).toHaveBeenCalledWith(15_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('retries 429 and every 5xx', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      stubFetch(textResponse(`body ${TOKEN}`, status))
      const error = await fail(config())
      expect(error, String(status)).toBeInstanceOf(RetryableError)
      expect((error as Error).message).toBe(`HTTP ${status}`)
    }
  })

  it('retries a network error without showing the token', async () => {
    stubFetchFailure(Object.assign(new TypeError(`fetch failed for ${TOKEN}`), { cause: { code: 'ETIMEDOUT' } }))
    const error = await fail(config())
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe('network error: ETIMEDOUT')
  })

  it('fails when the answer is larger than 64 KiB', async () => {
    stubFetch(textResponse('x'.repeat(65_537), 201))
    const error = await fail(config())
    expect(error).not.toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe('response is larger than 65536 bytes')
  })

  it('counts any 2xx answer as appended and does not read its body', async () => {
    for (const answer of [added(), jsonResponse({}, 200), textResponse(`echo ${TOKEN}`, 201), new Response(null, { status: 204 })]) {
      stubFetch(answer)
      expect(await run(config())).toEqual({ appended: true })
    }
  })
})

describe('microsoft.excel.append@1 connections and dry run', () => {
  it('sends nothing in a dry run and does not need the connection', async () => {
    const seen = stubFetch(added())
    const ctx = makeCtx({ dryRun: true, connections: { get: () => { throw new Error('must not look up') } } })
    expect(await run(config(), ctx)).toEqual({ appended: false })
    expect(await run(config({ connection: 'nobody' }), makeCtx({ dryRun: true }))).toEqual({ appended: false })
    expect(seen).toHaveLength(0)
  })

  it('fails for an unknown connection before any request', async () => {
    const seen = stubFetch(added())
    const error = await fail(config({ connection: 'other' }))
    expect((error as Error).message).toBe('unknown connection: other')
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(seen).toHaveLength(0)
  })

  it('refuses a connection that the engine knows as another kind', async () => {
    const seen = stubFetch(added())
    for (const kind of ['http', 'slack', 'google', 'webhookSecret']) {
      const error = await fail(config(), ctxWith(TOKEN, kind))
      expect((error as Error).message, kind).toBe(`connection ms is a ${kind} connection, not a microsoft connection`)
      expect((error as Error).message).not.toContain(TOKEN)
    }
    expect(seen).toHaveLength(0)
  })

  it('refuses a connection without a kind before any request', async () => {
    const seen = stubFetch(added())
    for (const ctx of [makeCtx({ connections: { get: () => TOKEN } }), makeCtx({ connections: { get: () => 'sk_live_ABCDEF0123456789', kindOf: () => undefined } })]) {
      const error = await fail(config(), ctx)
      expect((error as Error).message).toBe('connection ms has no kind, give it the kind microsoft')
      expect(error).not.toBeInstanceOf(RetryableError)
    }
    expect(seen).toHaveLength(0)
  })

  it('refuses a secret that is not an access token, without showing it', async () => {
    const seen = stubFetch(added())
    const secrets: Record<string, string> = {
      'a Slack bot token': 'xoxb-SLACKTOKENMARKER0123',
      'a structured Slack secret': encodeSlackBotSecret({ token: 'xoxb-SLACKTOKENMARKER0123' }),
      'a webhook URL': 'https://hooks.slack.com/services/T000/B000/WEBHOOKMARKER',
      'a structured auth secret': JSON.stringify({ rillAuth: 1, type: 'bearer', token: 'AUTHTOKENMARKER0123' }),
      'a secret with a space': 'eyJTOKEN MARKER0123456789.payload.sig',
      'a secret with a line break': 'eyJTOKENMARKER0123456789.payload.sig\nX-Evil: 1',
      'an empty secret': '',
    }
    for (const [label, secret] of Object.entries(secrets)) {
      const error = await fail(config(), ctxWith(secret, undefined))
      expect(error, label).toBeInstanceOf(Error)
      expect((error as Error).message, label).toMatch(/^(connection ms is a Slack connection|the connection does not hold an access token)$/)
      expect((error as Error).message).not.toMatch(/MARKER|X-Evil/)
    }
    expect(seen).toHaveLength(0)
  })
})
