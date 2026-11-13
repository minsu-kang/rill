import { useMemo } from 'react'
import type { LlmModelsResult, MethodName, MethodParams, MethodResult, ProviderId } from '@rill/protocol'
import type { EngineClient } from '../../engine/client'

export function mergeHostConfigured(models: LlmModelsResult, hostProviders: readonly ProviderId[]): LlmModelsResult {
  if (hostProviders.length === 0) return models
  const saved = new Set<string>(hostProviders)
  return {
    ...models,
    providers: models.providers.map((provider) => (provider.configured || !saved.has(provider.id) ? provider : { ...provider, configured: true })),
  }
}

export function withHostConfigured(client: EngineClient, hostProviders: readonly ProviderId[]): EngineClient {
  if (hostProviders.length === 0) return client
  return {
    onEvent: (listener) => client.onEvent(listener),
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      const result = await client.request(method, params)
      return (method === 'llmModels' ? mergeHostConfigured(result as LlmModelsResult, hostProviders) : result) as MethodResult<M>
    },
  }
}

export function useHostConfigured(client: EngineClient | undefined, configured: readonly ProviderId[] | undefined): EngineClient | undefined {
  const key = [...(configured ?? [])].sort().join(',')
  const providers = useMemo<ProviderId[]>(() => (key === '' ? [] : (key.split(',') as ProviderId[])), [key])
  return useMemo(() => (client === undefined ? undefined : withHostConfigured(client, providers)), [client, providers])
}
