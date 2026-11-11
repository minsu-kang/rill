import Type from 'typebox'
import { httpCall } from '../http'
import { defineAction } from '../types'

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
    const headers: Record<string, string> = { ...config.headers }
    const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
    if (config.body !== undefined && !names.has('content-type')) headers['Content-Type'] = 'application/json'
    if (method !== 'GET' && !names.has('idempotency-key')) headers['Idempotency-Key'] = ctx.idempotencyKey
    if (config.auth) {
      const secret = ctx.connections.get(config.auth.connection)
      if (secret === undefined) throw new Error(`unknown connection: ${config.auth.connection}`)
      const scheme = config.auth.scheme ?? 'Bearer'
      headers[config.auth.header ?? 'Authorization'] = scheme === 'None' ? secret : `${scheme} ${secret}`
    }
    return httpCall(config.url, {
      method,
      headers,
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
      timeoutMs: config.timeoutMs ?? 15_000,
      maxBytes: config.maxBytes,
    })
  },
})
