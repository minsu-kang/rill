import { findModel, parseModelSpec, providerDescriptor, LlmError, type LlmCapabilities, type ModelInfo, type ProviderId } from '@rill/llm'
import { UsageError } from './cli-shared'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  createEvalProvider,
  createRecorder,
  withDefaults,
  withEffort,
  withSignal,
  type EvalProvider,
  type EvalProviderOptions,
} from './record'
import { capabilitiesOfSpec } from './spec'

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/u

export interface ModelSpecInfo {
  spec: string
  provider: ProviderId
  model: string
  label: string
  keyEnv: string
  info: ModelInfo | undefined
  capabilities: LlmCapabilities
}

const API_HOSTS: Readonly<Record<ProviderId, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  grok: 'api.x.ai',
  meta: 'api.meta.ai',
}

export function describeSpec(spec: string): ModelSpecInfo {
  let parsed: { provider: ProviderId; model: string }
  try {
    parsed = parseModelSpec(spec)
  } catch (error) {
    throw new UsageError(error instanceof LlmError ? error.message : String(error))
  }
  const { provider, model } = parsed
  const descriptor = providerDescriptor(provider)
  if (model.toLowerCase().endsWith('-contributor')) {
    throw new UsageError(`'${model}' is a contributor model that trains on your content, so it is never used`)
  }
  const info = findModel(spec)
  if (provider !== 'anthropic' && info === undefined) {
    throw new UsageError(`unknown model '${model}' for ${descriptor.label}; known models: ${descriptor.models.map((entry) => entry.id).join(', ')}`)
  }
  return { spec, provider, model, label: descriptor.label, keyEnv: descriptor.keyEnv, info, capabilities: capabilitiesOfSpec(spec) }
}

export function resolveModelSpecs(name: string, specs: readonly string[]): ModelSpecInfo[] {
  const seen = new Set<string>()
  return specs.map((spec) => {
    const model = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec
    if (model !== '' && !MODEL_ID.test(model)) throw new UsageError(`${name} must list model ids, got: ${spec}`)
    const described = describeSpec(spec)
    const key = `${described.provider}:${described.model}`
    if (seen.has(key)) throw new UsageError(`${name} lists ${key} twice`)
    seen.add(key)
    return described
  })
}

export interface KeyNeed {
  provider: ProviderId
  label: string
  keyEnv: string
  specs: string[]
  present: boolean
}

export function keyNeeds(infos: readonly ModelSpecInfo[], env: Readonly<Record<string, string | undefined>>): KeyNeed[] {
  const needs = new Map<ProviderId, KeyNeed>()
  for (const info of infos) {
    const known = needs.get(info.provider)
    if (known !== undefined) known.specs.push(info.spec)
    else needs.set(info.provider, { provider: info.provider, label: info.label, keyEnv: info.keyEnv, specs: [info.spec], present: (env[info.keyEnv]?.trim() ?? '') !== '' })
  }
  return [...needs.values()]
}

export function missingKeysMessage(needs: readonly KeyNeed[]): string | undefined {
  const missing = needs.filter((need) => !need.present)
  if (missing.length === 0) return undefined
  const list = missing.map((need) => `${need.label} (set ${need.keyEnv}, needed by ${need.specs.join(', ')})`).join('; ')
  return `no API key for ${list}; --yes needs a key for every provider in the model list. Nothing was sent.`
}

export function hostsOf(infos: readonly ModelSpecInfo[]): Partial<Record<ProviderId, string>> {
  return Object.fromEntries(infos.map((info) => [info.provider, API_HOSTS[info.provider]]))
}

export function createSpecProvider(options: EvalProviderOptions): EvalProvider {
  if (options.apiKey.trim() === '') throw new Error('createSpecProvider needs a non-empty apiKey')
  const info = describeSpec(options.model)
  if (info.provider === 'anthropic') return createEvalProvider({ ...options, model: info.model })
  const recorder = createRecorder(options.fetch, options.clock, providerDescriptor(info.provider).exchange)
  const base = providerDescriptor(info.provider).create({ model: info.model, apiKey: options.apiKey, fetch: recorder.fetch, maxRetries: 0 })
  const limited = withDefaults(base, {
    maxTokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const efforted = options.effort === undefined ? limited : withEffort(limited, options.effort)
  return { provider: options.signal === undefined ? efforted : withSignal(efforted, options.signal), recorder }
}
