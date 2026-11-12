import { createHash } from 'node:crypto'
import type { LlmCapabilities } from '../capabilities'
import { checkSchemaLimits, type SchemaLimits } from '../schema'
import { LlmError, type LlmEffort, type LlmMessage, type LlmPart, type LlmRequest } from '../types'
import { MAX_PAGE_IMAGES, pdfPageImages } from './pdf-pages'

export const META_BASE_URL = 'https://api.meta.ai/v1'
const MAX_IMAGES_PER_REQUEST = 50
const SCHEMA_NAME = 'rill_output'

const SCHEMA_LIMITS: SchemaLimits = { maxDepth: 10, maxProperties: 5000, maxChars: 120_000, allowRecursion: false, maxEnumValues: 1000 }

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface ChatMessage {
  role: 'developer' | 'user' | 'assistant'
  content: string | ChatPart[]
}

export interface ChatBody {
  model: string
  messages: ChatMessage[]
  response_format: { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: unknown } }
  reasoning_effort: string
  max_completion_tokens: number
  prompt_cache_key?: string
  stream: true
  stream_options: { include_usage: true }
}

export interface BuildInput {
  model: string
  capabilities: LlmCapabilities
  request: LlmRequest
  maxTokens: number
  defaultEffort: LlmEffort
}

const invalid = (message: string) => new LlmError('invalid_request', message)

function systemText(system: LlmRequest['system']): string {
  if (system === undefined) return ''
  const blocks = typeof system === 'string' ? [system] : system.map((block) => block.text)
  return blocks.filter((text) => text !== '').join('\n\n')
}

function cacheKeyFor(system: string): string {
  return `rill-${createHash('sha256').update(system).digest('hex').slice(0, 16)}`
}

interface Attachments {
  images: number
  pageImages: number
  pdfs: number
  bytes: number
}

function checkAttachments(messages: readonly LlmMessage[], caps: LlmCapabilities): void {
  const found: Attachments = { images: 0, pageImages: 0, pdfs: 0, bytes: 0 }
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'image') {
        if (!caps.images.includes(part.mediaType)) throw invalid(`this provider does not take ${part.mediaType} images`)
        found.images += 1
        found.bytes += Buffer.byteLength(part.data, 'base64')
      } else if (part.type === 'document') {
        if (caps.documents === 'none') throw invalid('this provider does not read PDF files')
        found.pdfs += 1
        found.pageImages += pdfPageImages(part.data)
        found.bytes += Buffer.byteLength(part.data, 'base64')
      }
    }
  }
  const total = found.images + found.pageImages
  if (total > MAX_IMAGES_PER_REQUEST) {
    throw invalid(
      `this request would send ${total} images to Meta, above the limit of ${MAX_IMAGES_PER_REQUEST}: ${found.images} attached image(s) plus up to ${found.pageImages} page images from ${found.pdfs} PDF file(s), which Meta renders for the first ${MAX_PAGE_IMAGES} pages of each file`,
    )
  }
  const limit = caps.maxRequestBytes
  if (limit !== undefined && found.bytes > limit) {
    throw invalid(`the attached files add up to ${found.bytes} bytes, above the limit of ${limit} bytes for one request to Meta`)
  }
}

function toPart(part: LlmPart, documents: { count: number }): ChatPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
    case 'document':
      documents.count += 1
      return { type: 'file', file: { filename: `document-${documents.count}.pdf`, file_data: `data:${part.mediaType};base64,${part.data}` } }
  }
}

function toMessage(message: LlmMessage, documents: { count: number }): ChatMessage {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  if (message.role === 'assistant') {
    if (message.content.some((part) => part.type !== 'text')) throw invalid('an assistant message can only carry text')
    return { role: 'assistant', content: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') }
  }
  return { role: 'user', content: message.content.map((part) => toPart(part, documents)) }
}

export function buildChatRequest(input: BuildInput): ChatBody {
  const { request, capabilities } = input
  if (request.messages.at(-1)?.role !== 'user') {
    throw invalid('the last message must come from the user (assistant prefill is not supported)')
  }
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) throw invalid(`maxTokens must be a positive whole number, got ${input.maxTokens}`)
  const ceiling = capabilities.maxOutputTokens
  if (ceiling !== undefined && input.maxTokens > ceiling) throw invalid(`maxTokens ${input.maxTokens} is above the ${ceiling} output tokens this model allows`)
  checkSchemaLimits(request.schema, SCHEMA_LIMITS)
  checkAttachments(request.messages, capabilities)
  const documents = { count: 0 }
  const system = systemText(request.system)
  return {
    model: input.model,
    messages: [...(system === '' ? [] : [{ role: 'developer' as const, content: system }]), ...request.messages.map((message) => toMessage(message, documents))],
    response_format: { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: false, schema: request.schema } },
    reasoning_effort: capabilities.effortMap[request.effort ?? input.defaultEffort],
    max_completion_tokens: input.maxTokens,
    ...(system === '' ? {} : { prompt_cache_key: cacheKeyFor(system) }),
    stream: true,
    stream_options: { include_usage: true },
  }
}
