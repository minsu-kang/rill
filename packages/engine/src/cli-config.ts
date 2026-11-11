import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertPathAllowed, expandHome, type ConnectionResolver } from '@rill/nodes-core'
import type { PlanConnection } from '@rill/planner'

export class UsageError extends Error {}

export interface LoadedConnections {
  resolver: ConnectionResolver
  planConnections: PlanConnection[]
}

const KINDS: readonly string[] = ['slack', 'http', 'webhookSecret']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badEntry(name: string, reason: string): UsageError {
  return new UsageError(`connection ${JSON.stringify(name)} ${reason}`)
}

export function parseConnections(text: string): LoadedConnections {
  const table: unknown = JSON.parse(text)
  if (!isObject(table)) throw new UsageError('the connections file must be a JSON object that maps names to secrets')
  const secrets = new Map<string, string>()
  const planConnections: PlanConnection[] = []
  for (const [name, entry] of Object.entries(table)) {
    if (typeof entry === 'string') {
      secrets.set(name, entry)
      continue
    }
    if (!isObject(entry)) throw badEntry(name, 'must be a secret string or an object with "secret" and "kind"')
    const unknownKey = Object.keys(entry).find((key) => key !== 'secret' && key !== 'kind')
    if (unknownKey !== undefined) throw badEntry(name, `has an unknown key ${JSON.stringify(unknownKey)}`)
    if (typeof entry.secret !== 'string') throw badEntry(name, 'needs a "secret" that is a string')
    if (typeof entry.kind !== 'string' || !KINDS.includes(entry.kind)) {
      throw badEntry(name, `needs a "kind" of ${KINDS.join(', ')}`)
    }
    secrets.set(name, entry.secret)
    planConnections.push({ name, kind: entry.kind as PlanConnection['kind'] })
  }
  return { resolver: { get: (id) => secrets.get(id) }, planConnections }
}

export function loadConnections(file: string | undefined): LoadedConnections {
  return parseConnections(file === undefined ? '{}' : readFileSync(file, 'utf8'))
}

export function prepareAttachmentsDir(dir: string, allow: readonly string[] | undefined): string {
  const path = resolve(expandHome(dir))
  if (allow !== undefined && allow.length > 0) {
    try {
      assertPathAllowed(path, [...allow])
    } catch {
      throw new UsageError('--attachments-dir must be inside an --allow folder')
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}
