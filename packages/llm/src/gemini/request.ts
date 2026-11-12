import type { Interactions } from '@google/genai'
import type { LlmCapabilities } from '../capabilities'
import { checkSchemaLimits, dropUnsupported } from '../schema'
import { LlmError, type LlmMessage, type LlmPart, type LlmRequest, type LlmSystemBlock } from '../types'

export const IGNORED_SCHEMA_KEYWORDS = ['minLength', 'maxLength', 'minProperties', 'maxProperties', 'uniqueItems', 'contains', 'minContains', 'maxContains'] as const
export const MAX_PDF_BYTES = 50_000_000
export const MAX_IMAGES = 3_600

type Content = Interactions.TextContent | Interactions.DocumentContent | Interactions.ImageContent
type Input = Content[] | Array<Interactions.UserInputStep | Interactions.ModelOutputStep>
export type GeminiParams = Interactions.CreateModelInteractionParamsStreaming

const limitText = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`
const sizeText = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function systemText(system: string | LlmSystemBlock[] | undefined): string | undefined {
  const text = typeof system === 'string' ? system : system?.map((block) => block.text).join('\n\n')
  return text === undefined || text === '' ? undefined : text
}

function content(part: LlmPart): Content {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'document':
      return { type: 'document', mime_type: part.mediaType, data: part.data }
    case 'image':
      return { type: 'image', mime_type: part.mediaType, data: part.data }
  }
}

const userContent = (message: LlmMessage): Content[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(content)

function assistantContent(message: LlmMessage): Interactions.TextContent[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return message.content.map((part) => {
    if (part.type !== 'text') throw new LlmError('invalid_request', 'Gemini can only be shown earlier assistant turns as text')
    return { type: 'text', text: part.text }
  })
}

function checkAttachments(messages: readonly LlmMessage[], caps: LlmCapabilities): void {
  let images = 0
  let bytes = 0
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'text') continue
      const size = base64Bytes(part.data)
      bytes += size
      if (part.type === 'image') {
        images += 1
        if (!caps.images.includes(part.mediaType)) {
          throw new LlmError('invalid_request', `Gemini does not take ${part.mediaType} images; it takes ${caps.images.join(', ')}`)
        }
      } else if (caps.documents === 'none') {
        throw new LlmError('invalid_request', 'this provider does not read PDF files')
      } else if (size > MAX_PDF_BYTES) {
        throw new LlmError('invalid_request', `a PDF of ${sizeText(size)} is too large; Gemini takes PDF files up to ${limitText(MAX_PDF_BYTES)}`)
      }
    }
  }
  if (images > MAX_IMAGES) throw new LlmError('invalid_request', `a request can carry at most ${MAX_IMAGES} images, got ${images}`)
  if (caps.maxRequestBytes !== undefined && bytes > caps.maxRequestBytes) {
    throw new LlmError('invalid_request', `the attachments add up to ${sizeText(bytes)}; Gemini takes at most ${limitText(caps.maxRequestBytes)} of files in one request`)
  }
}

function inputOf(messages: readonly LlmMessage[]): Input {
  const [only, ...more] = messages
  if (only !== undefined && more.length === 0) return userContent(only)
  return messages.map((message) =>
    message.role === 'user' ? { type: 'user_input', content: userContent(message) } : { type: 'model_output', content: assistantContent(message) },
  )
}

function maxTokensOf(request: LlmRequest, caps: LlmCapabilities, fallback: number): number {
  const wanted = request.maxTokens ?? fallback
  if (!Number.isInteger(wanted) || wanted <= 0) throw new LlmError('invalid_request', `maxTokens must be a positive whole number, got ${wanted}`)
  return Math.min(wanted, caps.maxOutputTokens ?? wanted)
}

export function buildRequest(model: string, caps: LlmCapabilities, request: LlmRequest, defaultMaxTokens: number): GeminiParams {
  if (request.messages.at(-1)?.role !== 'user') {
    throw new LlmError('invalid_request', 'the last message must come from the user (assistant prefill is not supported)')
  }
  checkAttachments(request.messages, caps)
  const maxTokens = maxTokensOf(request, caps, defaultMaxTokens)
  const schema = dropUnsupported(request.schema, IGNORED_SCHEMA_KEYWORDS)
  checkSchemaLimits(schema, { maxDepth: Infinity, maxProperties: Infinity, maxChars: Infinity, allowRecursion: true })
  const system = systemText(request.system)
  return {
    model,
    ...(system === undefined ? {} : { system_instruction: system }),
    input: inputOf(request.messages),
    generation_config: {
      max_output_tokens: maxTokens,
      ...(request.effort === undefined ? {} : { thinking_level: caps.effortMap[request.effort] }),
    },
    response_format: { type: 'text', mime_type: 'application/json', schema },
    store: false,
    stream: true,
  }
}
