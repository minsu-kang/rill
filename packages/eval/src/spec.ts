import { ANTHROPIC_CAPABILITIES, PROVIDER_IDS, findModel, type LlmCapabilities, type ProviderId } from '@rill/llm'

export const SOFT_CAP_RESERVE_FACTOR = 2

function split(spec: string): { provider: ProviderId; model: string } | undefined {
  const colon = spec.indexOf(':')
  if (colon === -1) return undefined
  const provider = spec.slice(0, colon)
  const known = PROVIDER_IDS.find((id) => id === provider)
  return known === undefined ? undefined : { provider: known, model: spec.slice(colon + 1) }
}

export function modelIdOf(spec: string): string {
  return split(spec)?.model ?? spec
}

export function providerOfSpec(spec: string): ProviderId | undefined {
  if (!spec.includes(':')) return 'anthropic'
  return split(spec)?.provider
}

export function capabilitiesOfSpec(spec: string): LlmCapabilities {
  return findModel(spec)?.capabilities ?? ANTHROPIC_CAPABILITIES
}

export function unsupportedMediaReason(spec: string, mediaTypes: readonly string[]): string | undefined {
  const { documents, images } = capabilitiesOfSpec(spec)
  for (const mediaType of mediaTypes) {
    if (mediaType === 'application/pdf' && documents === 'none') return `${spec} reads no PDF files`
    if (mediaType.startsWith('image/') && !(images as readonly string[]).includes(mediaType)) return `${spec} does not take ${mediaType} images`
  }
  return undefined
}

export function softCapFactor(spec: string): number {
  return capabilitiesOfSpec(spec).reasoningCappedByMaxTokens ? 1 : SOFT_CAP_RESERVE_FACTOR
}
