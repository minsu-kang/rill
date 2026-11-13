import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnthropicProvider, DEFAULT_MODEL, LlmError, PROVIDER_IDS, createProvider, providerDescriptor, type LlmProvider, type ProviderId } from '@rill/llm'
import { assertPathAllowed, expandHome, parseSlackSecret, type ConnectionResolver } from '@rill/nodes-core'
import type { PlanConnection } from '@rill/planner'
import { configuredProviders, type EngineLlmInfo } from './llm-models'

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

function slackMode(kind: string, secret: string): Pick<PlanConnection, 'slack'> {
  if (kind !== 'slack') return {}
  const parsed = parseSlackSecret(secret)
  return parsed.kind === 'malformed' ? {} : { slack: parsed.kind }
}

function connectionsFromTable(table: unknown, source: string): LoadedConnections {
  if (!isObject(table)) throw new UsageError(`${source} must be a JSON object that maps names to secrets`)
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
    planConnections.push({ name, kind: entry.kind as PlanConnection['kind'], ...slackMode(entry.kind, entry.secret) })
  }
  return { resolver: { get: (id) => secrets.get(id) }, planConnections }
}

export function parseConnections(text: string): LoadedConnections {
  return connectionsFromTable(JSON.parse(text), 'the connections file')
}

export function loadConnections(file: string | undefined): LoadedConnections {
  return parseConnections(file === undefined ? '{}' : readFileSync(file, 'utf8'))
}

const CONNECTIONS_VARIABLE = 'RILL_CONNECTIONS'

export function resolveConnections(input: { file: string | undefined; env: Record<string, string | undefined> }): LoadedConnections {
  const given = input.env[CONNECTIONS_VARIABLE]
  delete input.env[CONNECTIONS_VARIABLE]
  if (given === undefined || given === '') return loadConnections(input.file)
  if (input.file !== undefined) throw new UsageError(`${CONNECTIONS_VARIABLE} and --connections cannot be used together`)
  let table: unknown
  try {
    table = JSON.parse(given)
  } catch {
    throw new UsageError(`${CONNECTIONS_VARIABLE} is not valid JSON`)
  }
  try {
    return connectionsFromTable(table, CONNECTIONS_VARIABLE)
  } catch (error) {
    if (error instanceof UsageError && !error.message.startsWith(CONNECTIONS_VARIABLE)) {
      throw new UsageError(`${CONNECTIONS_VARIABLE}: ${error.message}`)
    }
    throw error
  }
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

export interface LlmChoice {
  llm: LlmProvider | undefined
  info: EngineLlmInfo
}

export interface LlmChoiceInput {
  provider?: string
  model?: string
  noFallback?: boolean
  env: Readonly<Record<string, string | undefined>>
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

function checkModel(provider: ProviderId, model: string): void {
  try {
    createProvider(`${provider}:${model}`, { env: {} })
  } catch (error) {
    if (error instanceof LlmError && error.kind === 'invalid_request') throw new UsageError(`--llm-model: ${error.message}`)
    if (!(error instanceof LlmError && error.kind === 'auth')) throw error
  }
}

export function chooseLlm(input: LlmChoiceInput): LlmChoice {
  const provider = input.provider ?? 'anthropic'
  if (!isProviderId(provider)) throw new UsageError(`--llm-provider must be one of ${PROVIDER_IDS.join(', ')}`)
  const configured = configuredProviders(input.env)
  if (provider === 'anthropic') {
    if (input.model !== undefined) checkModel(provider, input.model)
    return {
      llm: new AnthropicProvider({
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.noFallback === true ? { refusalFallback: false } : {}),
      }),
      info: { configured, active: { provider, model: input.model ?? DEFAULT_MODEL } },
    }
  }
  if (input.model === undefined) {
    const known = providerDescriptor(provider).models.map((model) => model.id).join(', ')
    throw new UsageError(`--llm-provider ${provider} needs --llm-model; known models: ${known}`)
  }
  checkModel(provider, input.model)
  if (!configured.includes(provider)) return { llm: undefined, info: { configured, active: null } }
  return {
    llm: createProvider(`${provider}:${input.model}`, { env: input.env }),
    info: { configured, active: { provider, model: input.model } },
  }
}
