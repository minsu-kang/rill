import { anthropicDescriptor } from './anthropic-descriptor'
import { PROVIDER_IDS, type ModelInfo, type ProviderId } from './capabilities'
import type { ProviderDescriptor, ProviderFactoryOptions } from './descriptor'
import { geminiDescriptor } from './gemini'
import { grokDescriptor } from './grok'
import { metaDescriptor } from './meta'
import { openaiDescriptor } from './openai'
import { LlmError, type LlmProvider } from './types'

export interface ModelSpec {
  provider: ProviderId
  model: string
}

export type CreateProviderOptions = Omit<ProviderFactoryOptions, 'model' | 'apiKey'> & { env: Readonly<Record<string, string | undefined>> }

export interface Registry {
  parseSpec(spec: string): ModelSpec
  createProvider(spec: string, options: CreateProviderOptions): LlmProvider
  listModels(): ModelInfo[]
  findModel(spec: string): ModelInfo | undefined
  descriptor(id: ProviderId): ProviderDescriptor
}

const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value)
const isContributor = (model: string) => model.toLowerCase().endsWith('-contributor')

export function createRegistry(descriptors: readonly ProviderDescriptor[]): Registry {
  const byId = new Map(descriptors.map((entry) => [entry.id, entry]))
  const descriptor = (id: ProviderId): ProviderDescriptor => {
    const found = byId.get(id)
    if (found === undefined) throw new LlmError('invalid_request', `provider '${id}' is not available`)
    return found
  }

  const parseSpec = (spec: string): ModelSpec => {
    const trimmed = spec.trim()
    if (trimmed === '') throw new LlmError('invalid_request', 'the model spec is empty; use provider:model or a Claude model id')
    const colon = trimmed.indexOf(':')
    if (colon === -1) return { provider: 'anthropic', model: trimmed }
    const provider = trimmed.slice(0, colon)
    const model = trimmed.slice(colon + 1)
    if (!isProviderId(provider)) {
      throw new LlmError('invalid_request', `unknown provider '${provider}' in '${trimmed}'; known providers: ${PROVIDER_IDS.join(', ')}`)
    }
    if (model === '') throw new LlmError('invalid_request', `the model is missing in '${trimmed}'; use ${provider}:<model id>`)
    return { provider, model }
  }

  const findModel = (spec: string): ModelInfo | undefined => {
    let parsed: ModelSpec
    try {
      parsed = parseSpec(spec)
    } catch {
      return undefined
    }
    if (isContributor(parsed.model)) return undefined
    return byId.get(parsed.provider)?.models.find((model) => model.id === parsed.model)
  }

  const createProvider = (spec: string, options: CreateProviderOptions): LlmProvider => {
    const { provider, model } = parseSpec(spec)
    if (isContributor(model)) {
      throw new LlmError('invalid_request', `'${model}' is a contributor model that trains on your content, so it is never used`)
    }
    const chosen = descriptor(provider)
    if (provider !== 'anthropic' && !chosen.models.some((entry) => entry.id === model)) {
      throw new LlmError('invalid_request', `unknown model '${model}' for ${chosen.label}; known models: ${chosen.models.map((entry) => entry.id).join(', ')}`)
    }
    const apiKey = options.env[chosen.keyEnv]
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new LlmError('auth', `no API key for ${chosen.label}; set ${chosen.keyEnv}`)
    }
    const { fetch, client, baseURL, sleep, random } = options
    return chosen.create({
      model,
      apiKey,
      ...(fetch === undefined ? {} : { fetch }),
      ...(client === undefined ? {} : { client }),
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(sleep === undefined ? {} : { sleep }),
      ...(random === undefined ? {} : { random }),
    })
  }

  return { parseSpec, createProvider, findModel, descriptor, listModels: () => descriptors.flatMap((entry) => [...entry.models]) }
}

export const DEFAULT_DESCRIPTORS: readonly ProviderDescriptor[] = [anthropicDescriptor, openaiDescriptor, geminiDescriptor, grokDescriptor, metaDescriptor]

const defaultRegistry = createRegistry(DEFAULT_DESCRIPTORS)

export const parseModelSpec = defaultRegistry.parseSpec
export const createProvider = defaultRegistry.createProvider
export const listModels = defaultRegistry.listModels
export const findModel = defaultRegistry.findModel
export const providerDescriptor = defaultRegistry.descriptor
