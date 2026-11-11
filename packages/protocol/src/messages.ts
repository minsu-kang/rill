import Type from 'typebox'
import Value from 'typebox/value'
import { EngineEventSchema, type EngineEvent } from './events'
import { METHODS, type MethodName } from './methods'

export const PROTOCOL_VERSION = 1
export const SUBPROTOCOL = 'rill.v1'
const TOKEN_PREFIX = 'rill.token.'

const closed = { additionalProperties: false } as const

export const RequestSchema = Type.Object(
  {
    type: Type.Literal('request'),
    id: Type.String({ minLength: 1, maxLength: 64 }),
    method: Type.String({ minLength: 1, maxLength: 64 }),
    params: Type.Optional(Type.Unknown()),
  },
  closed,
)

export const ErrorBodySchema = Type.Object(
  { code: Type.String(), message: Type.String(), problems: Type.Optional(Type.Array(Type.String())) },
  closed,
)

export const ServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal('hello'), protocol: Type.Integer() }, closed),
  Type.Object(
    { type: Type.Literal('response'), id: Type.String(), ok: Type.Literal(true), result: Type.Unknown() },
    closed,
  ),
  Type.Object(
    { type: Type.Literal('response'), id: Type.String(), ok: Type.Literal(false), error: ErrorBodySchema },
    closed,
  ),
  Type.Object({ type: Type.Literal('event'), event: Type.Unknown() }, closed),
])

export type ClientRequest = Type.Static<typeof RequestSchema>
export type ServerMessage = Type.Static<typeof ServerMessageSchema>
export type ErrorBody = Type.Static<typeof ErrorBodySchema>
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function parseJson(raw: string): { ok: true; json: unknown } | { ok: false } {
  try {
    return { ok: true, json: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

export function parseRequest(raw: string): ParseResult<ClientRequest> {
  const parsed = parseJson(raw)
  if (!parsed.ok) return { ok: false, error: 'not valid JSON' }
  if (!Value.Check(RequestSchema, parsed.json)) return { ok: false, error: 'not a valid request' }
  return { ok: true, value: parsed.json }
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const parsed = parseJson(raw)
  if (!parsed.ok) return { ok: false, error: 'not valid JSON' }
  if (!Value.Check(ServerMessageSchema, parsed.json)) return { ok: false, error: 'not a valid server message' }
  return { ok: true, value: parsed.json }
}

export function parseEvent(value: unknown): EngineEvent | undefined {
  return Value.Check(EngineEventSchema, value) ? value : undefined
}

export type ParamsCheck =
  | { ok: true; method: MethodName; params: unknown }
  | { ok: false; code: 'UNKNOWN_METHOD' | 'INVALID_PARAMS'; problems: string[] }

export function validateParams(method: string, params: unknown): ParamsCheck {
  if (!Object.hasOwn(METHODS, method)) {
    return { ok: false, code: 'UNKNOWN_METHOD', problems: [`unknown method: ${method}`] }
  }
  const name = method as MethodName
  const value = params ?? {}
  const schema = METHODS[name].params
  if (Value.Check(schema, value)) return { ok: true, method: name, params: value }
  const problems = [...Value.Errors(schema, value)].map((e) => `${e.instancePath || '/'}: ${e.message}`)
  return { ok: false, code: 'INVALID_PARAMS', problems }
}

export function okResponse(id: string, result: unknown): ServerMessage {
  return { type: 'response', id, ok: true, result }
}

export function errorResponse(id: string, error: ErrorBody): ServerMessage {
  return { type: 'response', id, ok: false, error }
}

export function tokenProtocol(token: string): string {
  return `${TOKEN_PREFIX}${token}`
}

export function tokenFromProtocols(offered: string[]): string | undefined {
  for (const protocol of offered) {
    if (protocol.startsWith(TOKEN_PREFIX) && protocol.length > TOKEN_PREFIX.length) {
      return protocol.slice(TOKEN_PREFIX.length)
    }
  }
  return undefined
}
