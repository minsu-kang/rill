import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetryableError, type ConnectionResolver, type NodeContext } from '../src/index'
import { googleSheetsAppend } from '../src/nodes/google-sheets-append'
import { microsoftExcelAppend } from '../src/nodes/microsoft-excel-append'
import { jsonResponse, stubFetch, stubFetchFailure, textResponse, type SeenCall } from './fetch-stub'
import { makeCtx } from './helpers'

const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const FIRST = 'ya29.FIRSTMARKER0123456789'
const SECOND = 'ya29.SECONDMARKER9876543210'
const MS_FIRST = 'eyJFIRSTMARKER0123456789.payload.sig'
const MS_SECOND = 'eyJSECONDMARKER9876543210.payload.sig'
const UNAUTHORISED = 'HTTP 401: the sign-in is no longer valid, reconnect the account'

interface Kind {
  label: string
  kind: 'google' | 'microsoft'
  first: string
  second: string
  config: Record<string, unknown>
  run(config: unknown, ctx: NodeContext): Promise<unknown>
  success(): Response
  output: unknown
}

const KINDS: Kind[] = [
  {
    label: 'google.sheets.append@1',
    kind: 'google',
    first: FIRST,
    second: SECOND,
    config: { connection: 'google', spreadsheetId: SHEET, values: ['2026-11-12', 12.5, 'Cafe'] },
    run: (config, ctx) => googleSheetsAppend.execute(config, ctx),
    success: () => jsonResponse({ updates: { updatedRange: 'Sheet1!A2:C2' } }),
    output: { appended: true, updatedRange: 'Sheet1!A2:C2' },
  },
  {
    label: 'microsoft.excel.append@1',
    kind: 'microsoft',
    first: MS_FIRST,
    second: MS_SECOND,
    config: { connection: 'microsoft', filePath: 'Receipts/ledger.xlsx', table: 'Expenses', values: ['2026-11-12', 12.5, 'Cafe'] },
    run: (config, ctx) => microsoftExcelAppend.execute(config, ctx),
    success: () => jsonResponse({ index: 4 }, 201),
    output: { appended: true },
  },
]

function resolverFor(kind: Kind, renew: ConnectionResolver['renew'] | undefined, secret: () => string = () => kind.first): ConnectionResolver {
  return {
    get: (id) => (id === 'google' || id === 'microsoft' ? secret() : undefined),
    kindOf: (id) => (id === 'google' || id === 'microsoft' ? id : undefined),
    ...(renew === undefined ? {} : { renew }),
  }
}

const ctxFor = (kind: Kind, renew: ConnectionResolver['renew'] | undefined, overrides: Partial<NodeContext> = {}) => makeCtx({ connections: resolverFor(kind, renew), ...overrides })

const authOf = (call: SeenCall) => call.headers['authorization']

afterEach(() => {
  vi.unstubAllGlobals()
})

for (const kind of KINDS) {
  const fail = async (ctx: NodeContext): Promise<Error> => {
    try {
      await kind.run(kind.config, ctx)
    } catch (error) {
      return error as Error
    }
    throw new Error('expected the call to fail')
  }

  describe(`${kind.label}: renew once on a 401`, () => {
    it('renews after a 401 and repeats the same call with the new token', async () => {
      let answers = 0
      const seen = stubFetch(() => (++answers === 1 ? textResponse('expired', 401) : kind.success()))
      const renew = vi.fn(async () => kind.second)
      expect(await kind.run(kind.config, ctxFor(kind, renew))).toEqual(kind.output)
      expect(renew).toHaveBeenCalledTimes(1)
      expect(renew).toHaveBeenCalledWith(kind.kind)
      expect(seen).toHaveLength(2)
      expect(seen.map(authOf)).toEqual([`Bearer ${kind.first}`, `Bearer ${kind.second}`])
      expect(seen[1]!.url).toBe(seen[0]!.url)
      expect(seen[1]!.method).toBe('POST')
      expect(seen[1]!.body).toBe(seen[0]!.body)
    })

    it('asks for a renewal only after the first call was refused', async () => {
      const seen = stubFetch(kind.success())
      const renew = vi.fn(async () => kind.second)
      await kind.run(kind.config, ctxFor(kind, renew))
      expect(renew).not.toHaveBeenCalled()
      expect(seen).toHaveLength(1)
    })

    it('renews at most once, then fails with the usual 401 text', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const renew = vi.fn(async () => kind.second)
      const error = await fail(ctxFor(kind, renew))
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect(error.message).toBe(UNAUTHORISED)
      expect(renew).toHaveBeenCalledTimes(1)
      expect(seen).toHaveLength(2)
    })

    it('renews again for a later execution that is refused, once each', async () => {
      let answers = 0
      stubFetch(() => (answers++ % 2 === 0 ? textResponse('expired', 401) : kind.success()))
      const renew = vi.fn(async () => kind.second)
      const ctx = ctxFor(kind, renew)
      await kind.run(kind.config, ctx)
      await kind.run(kind.config, ctx)
      expect(renew).toHaveBeenCalledTimes(2)
    })

    for (const status of [400, 403, 404, 409, 422, 429, 500, 502, 503]) {
      it(`never renews after a ${status}`, async () => {
        const seen = stubFetch(textResponse('no', status))
        const renew = vi.fn(async () => kind.second)
        const error = await fail(ctxFor(kind, renew))
        expect(error).toBeInstanceOf(Error)
        expect(renew).not.toHaveBeenCalled()
        expect(seen).toHaveLength(1)
      })
    }

    it('never renews after a network error, a redirect or an answer that is too large', async () => {
      for (const answer of [() => stubFetchFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), () => stubFetch(new Response('', { status: 302, headers: { location: 'https://evil.test/' } })), () => stubFetch(textResponse('x'.repeat(65_537)))]) {
        const seen = answer()
        const renew = vi.fn(async () => kind.second)
        await fail(ctxFor(kind, renew))
        expect(renew).not.toHaveBeenCalled()
        expect(seen).toHaveLength(1)
      }
    })

    it('fails with the usual 401 text when the renewal gives the same token', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const error = await fail(ctxFor(kind, vi.fn(async () => kind.first)))
      expect(error.message).toBe(UNAUTHORISED)
      expect(seen).toHaveLength(1)
    })

    it('fails with the usual 401 text when the renewal gives nothing', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const error = await fail(ctxFor(kind, vi.fn(async () => undefined)))
      expect(error.message).toBe(UNAUTHORISED)
      expect(error).not.toBeInstanceOf(RetryableError)
      expect(seen).toHaveLength(1)
    })

    it('fails with the usual 401 text when the renewal throws, and shows nothing of the throw', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const error = await fail(ctxFor(kind, vi.fn(async () => Promise.reject(new Error(`broken ${kind.second}`)))))
      expect(error.message).toBe(UNAUTHORISED)
      expect(JSON.stringify(error)).not.toContain('SECONDMARKER')
      expect(seen).toHaveLength(1)
    })

    it('fails with the usual 401 text and sends nothing when the new secret is not an access token', async () => {
      const secrets = ['', 'short', 'two words here', `${kind.second}\nX-Evil: 1`, 'xoxb-SLACKTOKENMARKER0123456789', JSON.stringify({ rillAuth: 1, type: 'bearer', token: 'AUTHTOKENMARKER0123' }), 'a'.repeat(8193)]
      for (const secret of secrets) {
        const seen = stubFetch(textResponse('expired', 401))
        const error = await fail(ctxFor(kind, vi.fn(async () => secret)))
        expect(error.message, JSON.stringify(secret)).toBe(UNAUTHORISED)
        expect(seen).toHaveLength(1)
        expect(error.message).not.toMatch(/MARKER|X-Evil/)
      }
    })

    it('behaves as before when the resolver has no renew', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const error = await fail(ctxFor(kind, undefined))
      expect(error.message).toBe(UNAUTHORISED)
      expect(seen).toHaveLength(1)
    })

    it('never renews in a dry run and sends nothing', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const renew = vi.fn(async () => kind.second)
      await kind.run(kind.config, ctxFor(kind, renew, { dryRun: true }))
      expect(renew).not.toHaveBeenCalled()
      expect(seen).toHaveLength(0)
    })

    it('never renews for a connection that fails its checks before any request', async () => {
      const seen = stubFetch(textResponse('expired', 401))
      const renew = vi.fn(async () => kind.second)
      const other = kind.kind === 'google' ? 'microsoft' : 'google'
      for (const connections of [
        { get: () => undefined, renew },
        { get: () => kind.first, kindOf: () => other, renew },
        { get: () => kind.first, renew },
        { get: () => 'not a token', kindOf: () => kind.kind, renew },
      ] as ConnectionResolver[]) {
        await fail(makeCtx({ connections }))
      }
      expect(renew).not.toHaveBeenCalled()
      expect(seen).toHaveLength(0)
    })

    it('lets a refused second call fail the way the call fails today, retryable errors included', async () => {
      const cases: Array<[() => void, (error: Error) => void]> = [
        [
          () => {
            let answers = 0
            stubFetch(() => (++answers === 1 ? textResponse('expired', 401) : textResponse('busy', 503)))
          },
          (error) => {
            expect(error).toBeInstanceOf(RetryableError)
            expect(error.message).toBe('HTTP 503')
          },
        ],
        [
          () => {
            let answers = 0
            stubFetch(() => (++answers === 1 ? textResponse('expired', 401) : textResponse('no', 403)))
          },
          (error) => {
            expect(error).not.toBeInstanceOf(RetryableError)
            expect(error.message).toBe('HTTP 403: the account may not change this file')
          },
        ],
      ]
      for (const [arrange, check] of cases) {
        arrange()
        const renew = vi.fn(async () => kind.second)
        const error = await fail(ctxFor(kind, renew))
        check(error)
        expect(renew).toHaveBeenCalledTimes(1)
      }
    })

    it('keeps both tokens out of the error, the output and the request of a refused call', async () => {
      stubFetch((call) => textResponse(`bad ${authOf(call)} ${kind.first} ${kind.second}`, 401))
      const error = await fail(ctxFor(kind, vi.fn(async () => kind.second)))
      expect(error.message).toBe(UNAUTHORISED)
      expect(JSON.stringify(error)).not.toContain('MARKER')
      expect(error.stack ?? '').not.toContain('MARKER')
    })

    it('keeps both tokens out of a network error that follows the renewal', async () => {
      let answers = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          if (++answers === 1) return new Response('expired', { status: 401 })
          throw Object.assign(new TypeError(`fetch failed ${new Headers(init?.headers).get('authorization')} ${kind.first} ${kind.second}`), { cause: { code: 'ECONNRESET' } })
        }),
      )
      const error = await fail(ctxFor(kind, vi.fn(async () => kind.second)))
      expect(error).toBeInstanceOf(RetryableError)
      expect(error.message).toBe('network error: ECONNRESET')
      expect(JSON.stringify(error)).not.toContain('MARKER')
    })

    it('does not look at the connection table again for the retry, it uses what the renewal returned', async () => {
      let answers = 0
      const seen = stubFetch(() => (++answers === 1 ? textResponse('expired', 401) : kind.success()))
      let current = kind.first
      const ctx = makeCtx({ connections: resolverFor(kind, async () => kind.second, () => current) })
      await kind.run(kind.config, ctx)
      current = 'ya29.LATERMARKER0000000000'
      expect(seen.map(authOf)).toEqual([`Bearer ${kind.first}`, `Bearer ${kind.second}`])
    })
  })
}

describe('google.sheets.append@1: the new token in the answer', () => {
  it('masks both tokens in updatedRange when the answer after a renewal echoes them', async () => {
    let answers = 0
    stubFetch(() => (++answers === 1 ? textResponse('expired', 401) : jsonResponse({ updates: { updatedRange: `Sheet1!${FIRST}!${SECOND}` } })))
    const kind = KINDS[0]!
    const output = (await kind.run(kind.config, ctxFor(kind, async () => SECOND))) as { appended: boolean; updatedRange: string }
    expect(output.appended).toBe(true)
    expect(output.updatedRange).not.toContain('MARKER')
    expect(JSON.stringify(output)).not.toContain(FIRST)
    expect(JSON.stringify(output)).not.toContain(SECOND)
  })
})
