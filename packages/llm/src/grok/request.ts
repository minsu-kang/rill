import { createHash } from 'node:crypto'
import type { LlmCapabilities } from '../capabilities'
import { LlmError, type LlmEffort, type LlmMessage, type LlmPart, type LlmRequest } from '../types'
import { prepareGrokSchema } from './schema'

export const GROK_DEFAULT_MAX_TOKENS = 16_000
export const GROK_OUTPUT_NAME = 'rill_output'
export const GROK_MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface BodyDefaults {
  model: string
  maxTokens: number
  effort: LlmEffort
}

function systemText(system: LlmRequest['system']): string {
  if (system === undefined) return ''
  if (typeof system === 'string') return system
  return system
    .map((block) => block.text)
    .filter((text) => text !== '')
    .join('\n\n')
}

export const promptCacheKey = (system: string): string => `rill-${createHash('sha256').update(system).digest('hex').slice(0, 32)}`

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function inputPart(part: LlmPart, capabilities: LlmCapabilities): unknown {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text }
    case 'document':
      throw new LlmError('invalid_request', 'this provider does not read PDF files')
    case 'image':
      if (!capabilities.images.includes(part.mediaType)) {
        throw new LlmError('invalid_request', `this provider does not accept ${part.mediaType} images; use PNG or JPEG`)
      }
      if (base64Bytes(part.data) > GROK_MAX_IMAGE_BYTES) {
        throw new LlmError('invalid_request', 'an image is larger than the 20 MiB this provider accepts per image')
      }
      return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }
  }
}

function assistantText(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      if (part.type !== 'text') throw new LlmError('invalid_request', 'an assistant turn can only hold text')
      return part.text
    })
    .join('')
}

function inputMessage(message: LlmMessage, capabilities: LlmCapabilities): unknown {
  if (message.role === 'assistant') return { role: 'assistant', content: assistantText(message.content) }
  return { role: 'user', content: typeof message.content === 'string' ? message.content : message.content.map((part) => inputPart(part, capabilities)) }
}

export function buildBody(request: LlmRequest, capabilities: LlmCapabilities, defaults: BodyDefaults): Record<string, unknown> {
  if (request.messages.at(-1)?.role !== 'user') {
    throw new LlmError('invalid_request', 'the last message must come from the user (assistant prefill is not supported)')
  }
  const maxTokens = request.maxTokens ?? defaults.maxTokens
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new LlmError('invalid_request', `maxTokens must be a positive whole number, got ${maxTokens}`)
  }
  const effort = capabilities.effortMap[request.effort ?? defaults.effort]
  if (effort === undefined) throw new LlmError('invalid_request', `unknown effort level '${String(request.effort)}'`)
  const system = systemText(request.system)
  const input = request.messages.map((message) => inputMessage(message, capabilities))
  return {
    model: defaults.model,
    stream: true,
    store: false,
    ...(system === '' ? {} : { prompt_cache_key: promptCacheKey(system) }),
    max_output_tokens: maxTokens,
    reasoning: { effort },
    input: system === '' ? input : [{ role: 'system', content: system }, ...input],
    text: { format: { type: 'json_schema', name: GROK_OUTPUT_NAME, strict: true, schema: prepareGrokSchema(request.schema) } },
  }
}
