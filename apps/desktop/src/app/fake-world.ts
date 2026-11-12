import type { LlmModelsResult, MethodName, MethodParams, MethodResult } from '@rill/protocol'
import type { EngineClient } from '../engine/client'
import { models } from '../fixtures/plan'
import type { HostApi, Settings } from '../shared/host-api'

export function modelsFor(settings: Settings): LlmModelsResult {
  const configured = new Set(settings.configuredProviders)
  const providers = models.providers.map((provider) => ({ ...provider, configured: configured.has(provider.id) }))
  const own = models.models.filter((model) => model.provider === settings.provider)
  const picked = configured.has(settings.provider) ? (settings.model === undefined ? own[0] : own.find((model) => model.id === settings.model)) : undefined
  return { models: structuredClone(models.models), providers, active: picked === undefined ? null : { provider: picked.provider, model: picked.id } }
}

export function withHostModels(client: EngineClient, host: Pick<HostApi, 'settings'>): EngineClient {
  return {
    onEvent: (listener) => client.onEvent(listener),
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method !== 'llmModels') return client.request(method, params)
      return modelsFor(await host.settings.get()) as MethodResult<M>
    },
  }
}
