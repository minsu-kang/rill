import type { LlmRequest } from '@rill/llm'

export type SentPart = { type: 'text'; text: string } | { type: 'document' | 'image'; mediaType: string; bytes: number }

export interface SentMessage {
  role: 'user' | 'assistant'
  parts: SentPart[]
}

export interface SentRequest {
  system: string | null
  messages: SentMessage[]
}

function systemText(system: LlmRequest['system']): string | null {
  if (system === undefined) return null
  return typeof system === 'string' ? system : system.map((block) => block.text).join('\n\n')
}

export function summarizeRequest(request: LlmRequest): SentRequest {
  return {
    system: systemText(request.system),
    messages: request.messages.map((message) => ({
      role: message.role,
      parts:
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content.map((part): SentPart =>
              part.type === 'text'
                ? { type: 'text', text: part.text }
                : { type: part.type, mediaType: part.mediaType, bytes: Buffer.byteLength(part.data, 'base64') },
            ),
    })),
  }
}
