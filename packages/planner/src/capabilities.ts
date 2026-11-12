import { EFFORT_LEVELS, type LlmCapabilities, type LlmEffort, type LlmPart } from '@rill/llm'
import { AttachmentError } from './errors'
import { sanitiseAttachmentName } from './attachments/prepare'
import type { AttachmentRef } from './types'

export const SOFT_CAP_HEADROOM = 2

export const SOFT_CAP_NOTE =
  'This provider does not count hidden reasoning against max tokens, so the cap is soft: the cost can be above the estimate and the call can run longer.'

export interface ResolvedEffort {
  effective: LlmEffort
  native: string
  collapsed: boolean
}

export function resolveEffort(capabilities: LlmCapabilities, requested: LlmEffort): ResolvedEffort {
  const rank = EFFORT_LEVELS.indexOf(requested)
  const levels = EFFORT_LEVELS.filter((level) => capabilities.effortLevels.includes(level))
  const below = levels.filter((level) => EFFORT_LEVELS.indexOf(level) <= rank)
  const effective = levels.length === 0 ? requested : (below.at(-1) ?? levels[0]!)
  return { effective, native: capabilities.effortMap[effective], collapsed: effective !== requested }
}

function fail(code: 'unsupported_media' | 'too_large', ref: AttachmentRef, message: string): never {
  throw new AttachmentError(code, ref, message)
}

export function checkAttachmentSupport(provider: string, capabilities: LlmCapabilities, refs: readonly AttachmentRef[]): void {
  for (const ref of refs) {
    const name = sanitiseAttachmentName(ref.name)
    if (ref.mediaType === 'application/pdf') {
      if (capabilities.documents === 'none') {
        fail('unsupported_media', ref, `attachment "${name}" is a PDF, and the ${provider} provider cannot read PDF files`)
      }
      continue
    }
    if (!ref.mediaType.startsWith('image/')) continue
    if (!(capabilities.images as readonly string[]).includes(ref.mediaType)) {
      fail(
        'unsupported_media',
        ref,
        `attachment "${name}" is ${sanitiseAttachmentName(ref.mediaType)}, and the ${provider} provider only takes ${capabilities.images.join(', ')}`,
      )
    }
  }
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function binaryBytes(parts: readonly LlmPart[]): number {
  let total = 0
  for (const part of parts) if (part.type !== 'text') total += decodedBytes(part.data)
  return total
}

export function checkRequestBytes(provider: string, capabilities: LlmCapabilities, parts: readonly LlmPart[], ref: AttachmentRef): void {
  const cap = capabilities.maxRequestBytes
  if (cap === undefined) return
  const total = binaryBytes(parts)
  if (total > cap) fail('too_large', ref, `the attached PDFs and images add up to ${total} bytes, above the ${cap} bytes the ${provider} provider takes in one request`)
}
