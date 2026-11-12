import type OpenAI from 'openai'
import type { LlmCapabilities } from '../capabilities'
import { LlmError, type LlmMessage, type LlmPart, type LlmRequest, type LlmSystemBlock } from '../types'
import { prepareSchema } from './schema'

type Body = OpenAI.Responses.ResponseCreateParamsNonStreaming
type InputItem = OpenAI.Responses.EasyInputMessage
type Content = OpenAI.Responses.ResponseInputContent

export const SCHEMA_NAME = 'rill_output'
export const MIN_OUTPUT_TOKENS = 16
const BREAKPOINT = { prompt_cache_breakpoint: { mode: 'explicit' as const } }

export interface BuiltRequest {
  body: Body
  maxTokens: number
  restore(data: unknown): unknown
}

interface State {
  flagsLeft: number
  documents: number
  documentBytes: number
}

export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(data.length / 4) * 3 - padding)
}

const bytesText = (bytes: number): string => `${bytes.toLocaleString('en-US')} bytes`

function flag(cache: boolean | undefined, state: State): { prompt_cache_breakpoint?: { mode: 'explicit' } } {
  if (cache !== true || state.flagsLeft <= 0) return {}
  state.flagsLeft -= 1
  return BREAKPOINT
}

function contentOf(part: LlmPart, caps: LlmCapabilities, state: State): Content {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text, ...flag(part.cache, state) }
    case 'document':
      state.documents += 1
      state.documentBytes += base64Bytes(part.data)
      return {
        type: 'input_file',
        filename: `document-${state.documents}.pdf`,
        file_data: `data:application/pdf;base64,${part.data}`,
        ...flag(part.cache, state),
      }
    case 'image':
      if (!caps.images.includes(part.mediaType)) {
        throw new LlmError('invalid_request', `OpenAI does not take ${String(part.mediaType)} images; use ${caps.images.join(', ')}`)
      }
      return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}`, detail: 'auto', ...flag(part.cache, state) }
  }
}

function toItem(message: LlmMessage, caps: LlmCapabilities, state: State): InputItem {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  if (message.role === 'user') return { role: 'user', content: message.content.map((part) => contentOf(part, caps, state)) }
  const text = message.content.map((part) => {
    if (part.type !== 'text') throw new LlmError('invalid_request', 'an assistant message can only carry text')
    return part.text
  })
  return { role: 'assistant', content: text.join('') }
}

function developerItem(system: LlmRequest['system'], state: State): InputItem[] {
  if (system === undefined || system === '' || (Array.isArray(system) && system.length === 0)) return []
  const blocks: readonly LlmSystemBlock[] = typeof system === 'string' ? [{ text: system }] : system
  return [{ role: 'developer', content: blocks.map((block) => ({ type: 'input_text' as const, text: block.text, ...flag(block.cache, state) })) }]
}

export function buildRequest(request: LlmRequest, options: { model: string; caps: LlmCapabilities; defaultMaxTokens: number }): BuiltRequest {
  const { model, caps } = options
  if (request.messages.at(-1)?.role !== 'user') {
    throw new LlmError('invalid_request', 'the last message must come from the user (assistant prefill is not supported)')
  }
  const maxTokens = request.maxTokens ?? options.defaultMaxTokens
  const ceiling = caps.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
  if (!Number.isInteger(maxTokens) || maxTokens < MIN_OUTPUT_TOKENS || maxTokens > ceiling) {
    throw new LlmError('invalid_request', `maxTokens must be a whole number from ${MIN_OUTPUT_TOKENS} to ${ceiling}, got ${String(maxTokens)}`)
  }
  let native: string | undefined
  if (request.effort !== undefined) {
    native = caps.effortMap[request.effort]
    if (native === undefined) throw new LlmError('invalid_request', `unknown effort level '${String(request.effort)}'`)
  }
  const state: State = { flagsLeft: caps.maxCacheBreakpoints ?? 0, documents: 0, documentBytes: 0 }
  const input = [...developerItem(request.system, state), ...request.messages.map((message) => toItem(message, caps, state))]
  if (caps.maxRequestBytes !== undefined && state.documentBytes > caps.maxRequestBytes) {
    throw new LlmError(
      'invalid_request',
      `the PDF files add up to ${bytesText(state.documentBytes)}, above the ${bytesText(caps.maxRequestBytes)} OpenAI accepts for all files in one request`,
    )
  }
  const strict = prepareSchema(request.schema)
  const body: Body = {
    model,
    store: false,
    max_output_tokens: maxTokens,
    ...(native === undefined ? {} : { reasoning: { effort: native as NonNullable<OpenAI.Reasoning['effort']> } }),
    text: { format: { type: 'json_schema', name: SCHEMA_NAME, strict: true, schema: strict.schema } },
    input,
  }
  return { body, maxTokens, restore: strict.restore }
}
