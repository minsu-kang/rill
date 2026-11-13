import { vi } from 'vitest'

export interface SeenCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

export type Answer = Response | Promise<Response> | ((call: SeenCall) => Response | Promise<Response>)

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

const NULL_BODY = new Set([101, 204, 205, 304])

async function fresh(response: Response): Promise<Response> {
  const bytes = await response.clone().arrayBuffer()
  return new Response(NULL_BODY.has(response.status) ? null : bytes, { status: response.status, headers: response.headers })
}

export function stubFetch(answer: Answer): SeenCall[] {
  const seen: SeenCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call: SeenCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? init.body : undefined,
      }
      seen.push(call)
      const value = await (typeof answer === 'function' ? answer(call) : answer)
      return fresh(value)
    }),
  )
  return seen
}

export function stubFetchFailure(error: unknown): SeenCall[] {
  const seen: SeenCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      seen.push({ url: String(input), method: '', headers: {}, body: undefined })
      throw error
    }),
  )
  return seen
}
