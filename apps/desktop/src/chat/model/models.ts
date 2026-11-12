import type { LlmModelInfo, LlmModelsResult } from '@rill/protocol'

export function activeModelOf(models: LlmModelsResult): LlmModelInfo | undefined {
  const active = models.active
  if (active === null) return undefined
  return models.models.find((model) => model.provider === active.provider && model.id === active.model)
}

export function hasConfiguredProvider(models: LlmModelsResult): boolean {
  return models.providers.some((provider) => provider.configured)
}
