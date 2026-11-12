import { MODEL_TABLE, PROVIDER_IDS, providerDescriptor, type ModelInfo, type ProviderId } from '@rill/llm'
import type { LlmModelInfo, LlmModelsResult } from '@rill/protocol'

export interface EngineLlmInfo {
  configured: readonly ProviderId[]
  active: { provider: ProviderId; model: string } | null
}

type Environment = Readonly<Record<string, string | undefined>>

const hasValue = (value: string | undefined): boolean => value !== undefined && value.trim() !== ''

export function configuredProviders(env: Environment): ProviderId[] {
  return PROVIDER_IDS.filter(
    (id) => hasValue(env[providerDescriptor(id).keyEnv]) || (id === 'anthropic' && hasValue(env['ANTHROPIC_AUTH_TOKEN'])),
  )
}

function toModelInfo(model: ModelInfo): LlmModelInfo {
  const caps = model.capabilities
  return {
    provider: model.provider,
    id: model.id,
    tier: model.tier,
    label: model.label,
    contextTokens: model.contextTokens,
    capabilities: {
      structuredOutput: caps.structuredOutput,
      documents: caps.documents,
      images: [...caps.images],
      ...(caps.maxRequestBytes === undefined ? {} : { maxRequestBytes: caps.maxRequestBytes }),
      cache: caps.cache,
      ...(caps.maxCacheBreakpoints === undefined ? {} : { maxCacheBreakpoints: caps.maxCacheBreakpoints }),
      effortLevels: [...caps.effortLevels],
      effortMap: {
        low: caps.effortMap.low,
        medium: caps.effortMap.medium,
        high: caps.effortMap.high,
        xhigh: caps.effortMap.xhigh,
        max: caps.effortMap.max,
      },
      reasoningCappedByMaxTokens: caps.reasoningCappedByMaxTokens,
      streaming: caps.streaming,
      ...(caps.maxOutputTokens === undefined ? {} : { maxOutputTokens: caps.maxOutputTokens }),
      dataNote: caps.dataNote,
    },
  }
}

export function llmModelsResult(info: EngineLlmInfo | undefined): LlmModelsResult {
  const configured = new Set<ProviderId>(info?.configured ?? [])
  const active = info?.active ?? null
  return {
    models: MODEL_TABLE.map(toModelInfo),
    providers: PROVIDER_IDS.map((id) => {
      const descriptor = providerDescriptor(id)
      return { id, label: descriptor.label, keyEnv: descriptor.keyEnv, configured: configured.has(id) }
    }),
    active: active === null ? null : { provider: active.provider, model: active.model },
  }
}
