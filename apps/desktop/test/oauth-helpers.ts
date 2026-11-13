import { request } from 'node:http'
import type { OAuthClock, OAuthFetch, OAuthFetchInit } from '../src/main/oauth-flow'

export const GOOGLE_CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
export const GOOGLE_CLIENT_SECRET = 'GOCSPX-CLIENTSECRETMARKER0123456789'
export const MICROSOFT_CLIENT_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
export const GOOGLE_ACCESS = 'ya29.ACCESSMARKER0123456789abcdef'
export const GOOGLE_ACCESS_2 = 'ya29.ACCESSMARKER9876543210fedcba'
export const GOOGLE_REFRESH = '1//0gREFRESHMARKER0123456789abcdefghijklmnop'
export const GOOGLE_REFRESH_2 = '1//0gREFRESHMARKER9876543210zyxwvutsrqponm'
export const MICROSOFT_ACCESS = 'eyJACCESSMARKER0123456789.payload.signature'
export const MICROSOFT_ACCESS_2 = 'eyJACCESSMARKER9876543210.payload.signature'
export const MICROSOFT_REFRESH = '0.AAAREFRESHMARKER0123456789abcdefghijklmnop'
export const MICROSOFT_REFRESH_2 = '0.AAAREFRESHMARKER9876543210zyxwvutsrqponmlk'
export const GOOGLE_SCOPE = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets'
export const MICROSOFT_SCOPE = 'User.Read Files.ReadWrite profile openid email'
export const MARKERS = ['ACCESSMARKER', 'REFRESHMARKER', 'CLIENTSECRETMARKER', 'AUTHCODEMARKER', 'VERIFIERMARKER', 'PROVIDERTEXTMARKER']

export const GOOGLE_APP = { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
export const MICROSOFT_APP = { clientId: MICROSOFT_CLIENT_ID }

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function tokenAnswer(overrides: Record<string, unknown> = {}): Response {
  return json({ access_token: GOOGLE_ACCESS, expires_in: 3599, refresh_token: GOOGLE_REFRESH, scope: GOOGLE_SCOPE, token_type: 'Bearer', ...overrides })
}

export function microsoftTokenAnswer(overrides: Record<string, unknown> = {}): Response {
  return json({ access_token: MICROSOFT_ACCESS, expires_in: 3599, refresh_token: MICROSOFT_REFRESH, scope: MICROSOFT_SCOPE, token_type: 'Bearer', ...overrides })
}

export class ManualClock implements OAuthClock {
  private time: number
  private nextId = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  constructor(start = 1_700_000_000_000) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  setTimeout(run: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, run })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  pending(): number {
    return this.timers.size
  }

  jump(ms: number): void {
    this.time += ms
  }

  nextDelay(): number | undefined {
    const times = [...this.timers.values()].map((timer) => timer.at - this.time)
    return times.length === 0 ? undefined : Math.min(...times)
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    await settle()
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.time = Math.max(this.time, due[1].at)
      due[1].run()
      await settle()
    }
    this.time = target
    await settle()
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface RecordedCall {
  url: string
  init: OAuthFetchInit
  form: URLSearchParams
}

export function recordingFetch(respond: (call: RecordedCall) => Response | Promise<Response>): { fetch: OAuthFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetch: OAuthFetch = async (url, init) => {
    const call: RecordedCall = { url, init, form: new URLSearchParams(init.body ?? '') }
    calls.push(call)
    return respond(call)
  }
  return { fetch, calls }
}

export interface HttpAnswer {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

export function httpCall(options: { port: number; path: string; method?: string; host?: string }): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: options.port, path: options.path, method: options.method ?? 'GET', headers: { Host: options.host ?? `127.0.0.1:${options.port}` }, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

export function refuses(port: number): Promise<boolean> {
  return httpCall({ port, path: '/oauth/callback' }).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED',
  )
}

export function scanFor(text: string, markers: readonly string[] = MARKERS): string[] {
  return markers.filter((marker) => text.includes(marker))
}

export const unusedOAuth = {
  state: async () => ({ available: false, accounts: [], apps: [] }),
  setApp: async () => undefined,
  clearApp: async () => undefined,
  connect: async (): Promise<{ account?: string }> => {
    throw new Error('the sign-in is not part of this test')
  },
  cancel: () => undefined,
  disconnect: async () => undefined,
}
