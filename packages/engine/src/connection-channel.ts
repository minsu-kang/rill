import type { ConnectionResolver } from '@rill/nodes-core'
import type { PlanConnection } from '@rill/planner'

export const CHANNEL_KINDS = ['google', 'microsoft'] as const
export const MAX_CHANNEL_SECRET = 8192
export const RENEW_TIMEOUT_MS = 20_000

export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export type ConnectionMessage =
  | { type: 'connection.set'; name: ChannelKind; kind: ChannelKind; secret: string }
  | { type: 'connection.remove'; name: ChannelKind }

export interface RenewRequest {
  type: 'connection.renew'
  name: ChannelKind
}

export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage?(message: RenewRequest): void
}

export interface ConnectionChannel {
  ignored(): number
}

interface Renewal {
  promise: Promise<string | undefined>
  settle(secret: string | undefined): void
}

export class ConnectionTable {
  private readonly secrets = new Map<string, string>()
  private readonly kinds = new Map<string, string>()
  private readonly renewals = new Map<string, Renewal>()
  private ask: ((request: RenewRequest) => void) | undefined
  readonly planConnections: PlanConnection[] = []
  readonly resolver: ConnectionResolver = {
    get: (id) => this.secrets.get(id),
    kindOf: (id) => this.kinds.get(id),
    renew: (id) => this.renew(id),
  }

  onRenewRequest(ask: (request: RenewRequest) => void): void {
    this.ask = ask
  }

  answerRenewal(name: string, secret: string | undefined): void {
    this.renewals.get(name)?.settle(secret)
  }

  private renew(name: string): Promise<string | undefined> {
    const pending = this.renewals.get(name)
    if (pending !== undefined) return pending.promise
    if (this.ask === undefined || !isChannelKind(name) || this.kinds.get(name) !== name) return Promise.resolve(undefined)
    let resolve!: (secret: string | undefined) => void
    const promise = new Promise<string | undefined>((res) => {
      resolve = res
    })
    const settle = (secret: string | undefined): void => {
      clearTimeout(timer)
      if (this.renewals.get(name)?.promise === promise) this.renewals.delete(name)
      resolve(secret)
    }
    const timer = setTimeout(() => settle(undefined), RENEW_TIMEOUT_MS)
    this.renewals.set(name, { promise, settle })
    try {
      this.ask({ type: 'connection.renew', name })
    } catch {
      settle(undefined)
    }
    return promise
  }

  setPlain(name: string, secret: string): void {
    this.secrets.set(name, secret)
    this.kinds.delete(name)
    this.unlist(name)
  }

  setTyped(name: string, secret: string, kind: PlanConnection['kind'], extra: Pick<PlanConnection, 'slack'> = {}): void {
    this.secrets.set(name, secret)
    this.kinds.set(name, kind)
    const entry: PlanConnection = { name, kind, ...extra }
    const index = this.planConnections.findIndex((connection) => connection.name === name)
    if (index === -1) this.planConnections.push(entry)
    else this.planConnections[index] = entry
  }

  remove(name: string): void {
    this.secrets.delete(name)
    this.kinds.delete(name)
    this.unlist(name)
  }

  kindOf(name: string): string | undefined {
    return this.kinds.get(name)
  }

  has(name: string): boolean {
    return this.secrets.has(name)
  }

  private unlist(name: string): void {
    const index = this.planConnections.findIndex((connection) => connection.name === name)
    if (index !== -1) this.planConnections.splice(index, 1)
  }
}

function isChannelKind(value: unknown): value is ChannelKind {
  return value === 'google' || value === 'microsoft'
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function parseConnectionMessage(value: unknown): ConnectionMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { type, name, kind, secret } = value as Record<string, unknown>
  if (type === 'connection.set') {
    if (!hasExactKeys(value, ['type', 'name', 'kind', 'secret'])) return undefined
    if (!isChannelKind(name) || !isChannelKind(kind) || name !== kind) return undefined
    if (typeof secret !== 'string' || secret.length < 1 || secret.length > MAX_CHANNEL_SECRET) return undefined
    return { type, name, kind, secret }
  }
  if (type === 'connection.remove') {
    if (!hasExactKeys(value, ['type', 'name']) || !isChannelKind(name)) return undefined
    return { type, name }
  }
  return undefined
}

export function attachConnectionChannel(port: ParentPortLike | undefined, table: ConnectionTable): ConnectionChannel {
  let ignored = 0
  port?.on('message', (event) => {
    const message = parseConnectionMessage(event?.data)
    if (message === undefined) {
      ignored += 1
      return
    }
    const taken = table.has(message.name) && table.kindOf(message.name) !== message.name
    if (taken) {
      ignored += 1
      return
    }
    if (message.type === 'connection.set') {
      table.setTyped(message.name, message.secret, message.kind)
      table.answerRenewal(message.name, message.secret)
    } else {
      table.remove(message.name)
      table.answerRenewal(message.name, undefined)
    }
  })
  const post = port?.postMessage?.bind(port)
  if (post !== undefined) table.onRenewRequest(post)
  return { ignored: () => ignored }
}
