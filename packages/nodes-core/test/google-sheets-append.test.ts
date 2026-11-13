import Value from 'typebox/value'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetryableError, createCoreRegistry, encodeSlackBotSecret, fieldRoles } from '../src/index'
import { googleSheetsAppend } from '../src/nodes/google-sheets-append'
import { jsonResponse, stubFetch, stubFetchFailure, textResponse } from './fetch-stub'
import { makeCtx } from './helpers'

const TOKEN = 'ya29.TOKENMARKER0123456789'
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values`
const QUERY = 'valueInputOption=RAW&insertDataOption=INSERT_ROWS'

const ctxWith = (secret: string | undefined = TOKEN, kind: string | undefined = 'google') =>
  makeCtx({ connections: { get: (id) => (id === 'g' ? secret : undefined), kindOf: (id) => (id === 'g' ? kind : undefined) } })

const config = (extra: Record<string, unknown> = {}) => ({ connection: 'g', spreadsheetId: SHEET, values: ['2026-11-12', 12.5, true, null, 'Cafe'], ...extra })

const updated = (range = 'Sheet1!A2:E2') => jsonResponse({ spreadsheetId: SHEET, updates: { spreadsheetId: SHEET, updatedRange: range, updatedRows: 1 } })

const run = (cfg: Record<string, unknown>, ctx = ctxWith()) => googleSheetsAppend.execute(cfg, ctx)
const fail = (cfg: Record<string, unknown>, ctx = ctxWith()) => run(cfg, ctx).catch((error: unknown) => error as Error)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('google.sheets.append@1 definition', () => {
  it('is a registered external node with a recipient spreadsheet and a connection', () => {
    expect(googleSheetsAppend.type).toBe('google.sheets.append@1')
    expect(googleSheetsAppend.sideEffect).toBe('external')
    expect(createCoreRegistry().has('google.sheets.append@1')).toBe(true)
    expect(Object.fromEntries(fieldRoles(googleSheetsAppend).map(({ pointer, role }) => [pointer, role]))).toEqual({ '/connection': 'connection', '/spreadsheetId': 'recipient' })
  })

  it('says what it needs and warns about a duplicate row', () => {
    const text = googleSheetsAppend.description
    expect(text).toMatch(/^Appends one row to a Google Sheets spreadsheet/)
    expect(text).toContain('google connection')
    expect(text).toContain('spreadsheetId')
    expect(text).toContain('twice')
    expect(text).toContain('A retry after a server error, a timeout or a network error can do the same.')
    expect(text).toContain('not evaluated')
  })

  it('has an output of appended and a short updatedRange', () => {
    expect(Value.Check(googleSheetsAppend.outputSchema, { appended: true, updatedRange: 'Sheet1!A2:E2' })).toBe(true)
    expect(Value.Check(googleSheetsAppend.outputSchema, { appended: true, updatedRange: 'x'.repeat(201) })).toBe(false)
    expect(Value.Check(googleSheetsAppend.outputSchema, { appended: 'yes', updatedRange: '' })).toBe(false)
  })
})

describe('google.sheets.append@1 config limits', () => {
  const ok = (cfg: Record<string, unknown>) => Value.Check(googleSheetsAppend.configSchema, cfg)

  it('accepts the plain form and every limit edge', () => {
    expect(ok(config())).toBe(true)
    expect(ok(config({ spreadsheetId: 'a'.repeat(20) }))).toBe(true)
    expect(ok(config({ spreadsheetId: 'a-B_9'.repeat(20) }))).toBe(true)
    expect(ok(config({ range: 'x'.repeat(120) }))).toBe(true)
    expect(ok(config({ values: Array.from({ length: 50 }, () => 'v') }))).toBe(true)
    expect(ok(config({ values: ['x'.repeat(2000)] }))).toBe(true)
  })

  it('rejects a spreadsheet id that is too short, too long or not made of id characters', () => {
    for (const spreadsheetId of ['a'.repeat(19), 'a'.repeat(101), `${'a'.repeat(20)}/`, `${'a'.repeat(20)}%2F`, `${'a'.repeat(20)} `, `${'a'.repeat(20)}?x=1`, `${'a'.repeat(20)}..`, `${'a'.repeat(20)}\n`, '']) {
      expect(ok(config({ spreadsheetId })), JSON.stringify(spreadsheetId)).toBe(false)
    }
  })

  it('rejects a range with ?, #, /, backslash, %, control characters or too many characters', () => {
    for (const range of ['Sheet1?x=1', 'Sheet1#gid', 'a/b', 'a\\b', 'Sheet%2F1', 'Sheet\n1', 'Sheet\u00001', 'a‮b', '', 'x'.repeat(121), 'Sheet1&x', 'Sheet1;x', 'a<b', 'a"b', 'a*b']) {
      expect(ok(config({ range })), JSON.stringify(range)).toBe(false)
    }
  })

  it('accepts a sheet name or an A1 range, also with spaces, quotes and letters of any language', () => {
    for (const range of ['Sheet1', 'Receipts!A:D', 'Sheet1!A1:D10', "'My Sheet'!A:D", '영수증!A:D', 'Sheet 2', "Sheet1!$A$1:$D$1", 'Q1.2026']) {
      expect(ok(config({ range })), range).toBe(true)
    }
  })

  it('rejects empty and too long rows, bad cells, long text and unknown keys', () => {
    expect(ok(config({ values: [] }))).toBe(false)
    expect(ok(config({ values: Array.from({ length: 51 }, () => 'v') }))).toBe(false)
    expect(ok(config({ values: ['x'.repeat(2001)] }))).toBe(false)
    expect(ok(config({ values: [{ a: 1 }] }))).toBe(false)
    expect(ok(config({ values: [['nested']] }))).toBe(false)
    expect(ok(config({ values: 'one' }))).toBe(false)
    expect(ok(config({ extra: 1 }))).toBe(false)
    expect(ok({ connection: 'g', values: ['a'] })).toBe(false)
    expect(ok({ connection: '', spreadsheetId: SHEET, values: ['a'] })).toBe(false)
  })

  it('refuses a bad value in execute itself, before any request', async () => {
    const seen = stubFetch(updated())
    for (const cfg of [
      config({ spreadsheetId: `${SHEET}/../x` }),
      config({ spreadsheetId: 'short' }),
      config({ range: 'Sheet1?x=1' }),
      config({ range: 'Sheet1#a' }),
      config({ range: 'a/b' }),
      config({ range: 'Sheet%2F1' }),
      config({ values: [] }),
      config({ values: Array.from({ length: 51 }, () => 'v') }),
    ]) {
      const error = await fail(cfg)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect((error as Error).message).toMatch(/^invalid config: \//)
      expect((error as Error).message).not.toContain(TOKEN)
    }
    expect(seen).toHaveLength(0)
  })
})

describe('google.sheets.append@1 request', () => {
  it('posts one row to the default range with RAW input and a bearer token', async () => {
    const seen = stubFetch(updated())
    const output = await run(config())
    expect(output).toEqual({ appended: true, updatedRange: 'Sheet1!A2:E2' })
    expect(seen).toHaveLength(1)
    const call = seen[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`${BASE}/Sheet1:append?${QUERY}`)
    expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(call.headers['content-type']).toBe('application/json')
    expect(JSON.parse(call.body!)).toEqual({ values: [['2026-11-12', 12.5, true, null, 'Cafe']] })
  })

  it('encodes the range as one path part and keeps :append after it', async () => {
    const seen = stubFetch(updated())
    await run(config({ range: 'Receipts!A:D' }))
    await run(config({ range: "'My Sheet'!A1:D10" }))
    await run(config({ range: '영수증!A:D' }))
    expect(seen.map((call) => call.url)).toEqual([
      `${BASE}/Receipts%21A%3AD:append?${QUERY}`,
      `${BASE}/%27My%20Sheet%27%21A1%3AD10:append?${QUERY}`,
      `${BASE}/${encodeURIComponent('영수증')}%21A%3AD:append?${QUERY}`,
    ])
  })

  it('keeps the host and the path prefix fixed whatever the id and range hold', async () => {
    const seen = stubFetch(updated())
    await run(config({ spreadsheetId: 'a-b_c'.repeat(8), range: 'a.b' }))
    const url = new URL(seen[0]!.url)
    expect(url.origin).toBe('https://sheets.googleapis.com')
    expect(url.pathname.startsWith('/v4/spreadsheets/')).toBe(true)
    expect(url.pathname.split('/')).toHaveLength(6)
    expect([...url.searchParams.keys()]).toEqual(['valueInputOption', 'insertDataOption'])
  })

  it('sends a formula-looking text as given, because RAW does not evaluate it', async () => {
    const seen = stubFetch(updated())
    await run(config({ values: ['=HYPERLINK("http://evil.test","x")', '+1', '@SUM(A1)', '-5', '  =x'] }))
    expect(JSON.parse(seen[0]!.body!)).toEqual({ values: [['=HYPERLINK("http://evil.test","x")', '+1', '@SUM(A1)', '-5', '  =x']] })
    expect(seen[0]!.url).toContain('valueInputOption=RAW')
    expect(seen[0]!.url).not.toContain('USER_ENTERED')
  })

  it('reads the token again for every call', async () => {
    const seen = stubFetch(updated())
    let current = TOKEN
    const ctx = makeCtx({ connections: { get: () => current, kindOf: () => 'google' } })
    await run(config(), ctx)
    current = 'ya29.REFRESHEDTOKEN0123456789'
    await run(config(), ctx)
    expect(seen.map((call) => call.headers['authorization'])).toEqual([`Bearer ${TOKEN}`, 'Bearer ya29.REFRESHEDTOKEN0123456789'])
  })

  it('does not follow a redirect', async () => {
    const seen = stubFetch(new Response('', { status: 302, headers: { location: 'https://evil.test/' } }))
    const error = await fail(config())
    expect((error as Error).message).toBe('HTTP 302: redirects are not followed')
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(seen).toHaveLength(1)
  })
})

describe('google.sheets.append@1 answers', () => {
  const STATUS: [number, string][] = [
    [400, 'HTTP 400: the data was not accepted'],
    [401, 'HTTP 401: the sign-in is no longer valid, reconnect the account'],
    [403, 'HTTP 403: the account may not change this file'],
    [404, 'HTTP 404: the file, sheet or table was not found'],
    [409, 'HTTP 409: the request was not accepted'],
    [499, 'HTTP 499: the request was not accepted'],
    [422, 'HTTP 422: the request was not accepted'],
  ]

  for (const [status, message] of STATUS) {
    it(`maps ${status} to a fixed reason that is not retried`, async () => {
      stubFetch(textResponse('SECRET-BODY-TEXT from the server', status))
      const error = await fail(config())
      expect((error as Error).message).toBe(message)
      expect(error).not.toBeInstanceOf(RetryableError)
    })
  }

  it('never shows the body of an error answer, even when it echoes the credentials', async () => {
    stubFetch((call) => jsonResponse({ error: { message: `bad ${call.headers['authorization']} and ${TOKEN}` } }, 400))
    const error = await fail(config())
    expect((error as Error).message).toBe('HTTP 400: the data was not accepted')
    expect(JSON.stringify(error)).not.toContain('TOKENMARKER')
    expect((error as Error).stack ?? '').not.toContain('TOKENMARKER')
  })

  it('gives the request 15 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      stubFetch(updated())
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
    stubFetchFailure(Object.assign(new TypeError(`fetch failed for ${TOKEN}`), { cause: { code: 'ECONNRESET' } }))
    const error = await fail(config())
    expect(error).toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe('network error: ECONNRESET')
  })

  it('fails when the answer is larger than 64 KiB', async () => {
    stubFetch(textResponse('x'.repeat(65_537)))
    const error = await fail(config())
    expect(error).not.toBeInstanceOf(RetryableError)
    expect((error as Error).message).toBe('response is larger than 65536 bytes')
  })

  it('takes updatedRange from the answer, limited to 200 characters and cleaned of control characters', async () => {
    stubFetch(updated(`Sheet1!A2:E2\n${'z'.repeat(300)}`))
    const output = (await run(config())) as { appended: boolean; updatedRange: string }
    expect(output.appended).toBe(true)
    expect(output.updatedRange.length).toBeLessThanOrEqual(200)
    expect(output.updatedRange).not.toMatch(/\p{Cc}/u)
    expect(output.updatedRange.startsWith('Sheet1!A2:E2')).toBe(true)
  })

  it('masks the token when the answer echoes it in updatedRange', async () => {
    stubFetch(updated(`Sheet1!${TOKEN}`))
    const output = (await run(config())) as { updatedRange: string }
    expect(output.updatedRange).not.toContain('TOKENMARKER')
    expect(JSON.stringify(output)).not.toContain(TOKEN)
  })

  it('gives an empty updatedRange when the answer has none or has another shape', async () => {
    for (const answer of [jsonResponse({}), jsonResponse({ updates: {} }), jsonResponse({ updates: { updatedRange: 42 } }), jsonResponse([1]), textResponse('ok'), new Response('', { status: 200 })]) {
      stubFetch(answer)
      expect(await run(config())).toEqual({ appended: true, updatedRange: '' })
    }
  })

  it('reads a JSON answer that has no JSON content type', async () => {
    stubFetch(new Response(JSON.stringify({ updates: { updatedRange: 'Sheet1!A9:E9' } }), { status: 200 }))
    expect(await run(config())).toEqual({ appended: true, updatedRange: 'Sheet1!A9:E9' })
  })

  it('keeps the output inside its schema', async () => {
    stubFetch(updated('x'.repeat(500)))
    expect(Value.Check(googleSheetsAppend.outputSchema, await run(config()))).toBe(true)
  })
})

describe('google.sheets.append@1 connections and dry run', () => {
  it('sends nothing in a dry run and does not need the connection', async () => {
    const seen = stubFetch(updated())
    const ctx = makeCtx({ dryRun: true, connections: { get: () => { throw new Error('must not look up') } } })
    expect(await run(config(), ctx)).toEqual({ appended: false, updatedRange: '' })
    expect(await run(config({ connection: 'nobody' }), makeCtx({ dryRun: true }))).toEqual({ appended: false, updatedRange: '' })
    expect(seen).toHaveLength(0)
  })

  it('fails for an unknown connection before any request', async () => {
    const seen = stubFetch(updated())
    const error = await fail(config({ connection: 'other' }))
    expect((error as Error).message).toBe('unknown connection: other')
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(seen).toHaveLength(0)
  })

  it('refuses a connection that the engine knows as another kind', async () => {
    const seen = stubFetch(updated())
    for (const kind of ['http', 'slack', 'microsoft', 'webhookSecret']) {
      const error = await fail(config(), ctxWith(TOKEN, kind))
      expect((error as Error).message, kind).toBe(`connection g is a ${kind} connection, not a google connection`)
      expect((error as Error).message).not.toContain(TOKEN)
    }
    expect(seen).toHaveLength(0)
  })

  it('refuses a connection without a kind before any request, also a token of a stripe-like key', async () => {
    const seen = stubFetch(updated())
    for (const ctx of [makeCtx({ connections: { get: () => TOKEN } }), makeCtx({ connections: { get: () => 'sk_live_ABCDEF0123456789', kindOf: () => undefined } })]) {
      const error = await fail(config(), ctx)
      expect((error as Error).message).toBe('connection g has no kind, give it the kind google')
      expect(error).not.toBeInstanceOf(RetryableError)
    }
    expect(seen).toHaveLength(0)
  })

  it('refuses a secret that is not an access token, without showing it', async () => {
    const seen = stubFetch(updated())
    const secrets: Record<string, string> = {
      'a Slack bot token': 'xoxb-SLACKTOKENMARKER0123',
      'a structured Slack secret': encodeSlackBotSecret({ token: 'xoxb-SLACKTOKENMARKER0123' }),
      'a webhook URL': 'https://hooks.slack.com/services/T000/B000/WEBHOOKMARKER',
      'a structured auth secret': JSON.stringify({ rillAuth: 1, type: 'bearer', token: 'AUTHTOKENMARKER0123' }),
      'a secret with a space': 'ya29.TOKEN MARKER0123456789',
      'a secret with a line break': 'ya29.TOKENMARKER0123456789\nX-Evil: 1',
      'a too short secret': 'ya29',
      'an empty secret': '',
    }
    for (const [label, secret] of Object.entries(secrets)) {
      const error = await fail(config(), ctxWith(secret, undefined))
      expect(error, label).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect((error as Error).message, label).toMatch(/^(connection g is a Slack connection|the connection does not hold an access token)$/)
      expect((error as Error).message).not.toMatch(/MARKER|X-Evil/)
    }
    expect(seen).toHaveLength(0)
  })
})
