import Type from 'typebox'
import { applyConnectionAuth, maskSecretParts, parseConnectionSecret, secretParts } from '../connection-auth'
import { httpCall, type HttpResult } from '../http'
import { RetryableError, defineAction } from '../types'

function maskDeep(value: unknown, parts: readonly string[]): unknown {
  if (typeof value === 'string') return maskSecretParts(value, parts)
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, parts))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item, parts)]))
  return value
}

function maskedFailure(error: unknown, parts: readonly string[]): unknown {
  if (!(error instanceof Error)) return error
  const message = maskSecretParts(error.message, parts)
  if (message === error.message) return error
  return error instanceof RetryableError ? new RetryableError(message) : new Error(message)
}

export const httpRequest = defineAction({
  type: 'http.request@1',
  title: 'HTTP request',
  description:
    'Calls an HTTP endpoint with JSON. Network errors, timeouts, 429 and 5xx are retried; redirects and other non-2xx responses fail the node. Non-GET calls send an Idempotency-Key header. Credentials come from a connection, never from the workflow.',
  sideEffect: 'external',
  roles: { '/url': 'url', '/auth/connection': 'connection' },
  configSchema: Type.Object(
    {
      url: Type.String({ pattern: '^https?://' }),
      method: Type.Optional(
        Type.Union([
          Type.Literal('GET'),
          Type.Literal('POST'),
          Type.Literal('PUT'),
          Type.Literal('PATCH'),
          Type.Literal('DELETE'),
        ]),
      ),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.Unknown()),
      auth: Type.Optional(
        Type.Object(
          {
            connection: Type.String({ minLength: 1 }),
            header: Type.Optional(Type.String({ minLength: 1 })),
            scheme: Type.Optional(Type.Union([Type.Literal('Bearer'), Type.Literal('Basic'), Type.Literal('None')])),
          },
          { additionalProperties: false },
        ),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_971_520 })),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object({
    status: Type.Integer(),
    headers: Type.Record(Type.String(), Type.String()),
    body: Type.Unknown(),
    dryRun: Type.Optional(Type.Boolean()),
  }),
  execute: async (config, ctx) => {
    if (ctx.dryRun) return { status: 0, headers: {}, body: null, dryRun: true }
    const method = config.method ?? 'GET'
    if (method === 'GET' && config.body !== undefined) throw new Error('GET requests cannot have a body')
    let headers: Record<string, string> = { ...config.headers }
    let url = config.url
    let hidden: string[] = []
    const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
    if (config.body !== undefined && !names.has('content-type')) headers['Content-Type'] = 'application/json'
    if (method !== 'GET' && !names.has('idempotency-key')) headers['Idempotency-Key'] = ctx.idempotencyKey
    if (config.auth) {
      const secret = ctx.connections.get(config.auth.connection)
      if (secret === undefined) throw new Error(`unknown connection: ${config.auth.connection}`)
      const parsed = parseConnectionSecret(secret)
      if (parsed.kind === 'malformed') throw new Error(`connection ${config.auth.connection} has a malformed auth value`)
      if (parsed.kind === 'structured') {
        ;({ url, headers } = applyConnectionAuth(parsed.auth, url, headers))
        hidden = secretParts(secret)
      } else {
        const scheme = config.auth.scheme ?? 'Bearer'
        headers[config.auth.header ?? 'Authorization'] = scheme === 'None' ? secret : `${scheme} ${secret}`
      }
    }
    let result: HttpResult
    try {
      result = await httpCall(url, {
        method,
        headers,
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
        timeoutMs: config.timeoutMs ?? 15_000,
        maxBytes: config.maxBytes,
      })
    } catch (error) {
      throw maskedFailure(error, hidden)
    }
    return hidden.length === 0 ? result : (maskDeep(result, hidden) as HttpResult)
  },
})
