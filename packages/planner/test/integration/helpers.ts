import type { LlmRequest } from '@rill/llm'
import type { AttachmentRef, AttachmentStore } from '../../src/index'

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

export interface CountingStore extends AttachmentStore {
  reads: string[]
}

export function countingStore(files: Record<string, Uint8Array>): CountingStore {
  const reads: string[] = []
  return {
    reads,
    read: async (id) => {
      reads.push(id)
      return Object.hasOwn(files, id) ? files[id] : undefined
    },
  }
}

export function attachmentRef(id: string, mediaType: AttachmentRef['mediaType'], bytes = 10): AttachmentRef {
  return { id, mediaType, name: `${id}.bin`, bytes }
}

export function flatText(request: LlmRequest): string {
  return JSON.stringify(request)
}

export function breakpoints(request: LlmRequest): number {
  let count = request.cache === true ? 1 : 0
  if (request.system !== undefined && typeof request.system !== 'string') count += request.system.filter((block) => block.cache === true).length
  for (const message of request.messages) {
    if (typeof message.content !== 'string') count += message.content.filter((part) => part.cache === true).length
  }
  return count
}

export function tailAfter(request: LlmRequest, baseMessages: number): LlmRequest['messages'] {
  return request.messages.slice(baseMessages)
}
