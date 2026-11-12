import type { AttachmentRef } from '@rill/protocol'
import type { MessageKey } from '../../i18n'
import { markHidden } from './clamp'
import { truncate } from '../../model/text'

type MediaType = AttachmentRef['mediaType']

const MIB = 1024 * 1024

export const ATTACHMENT_LIMITS = { pdfBytes: 20 * MIB, imageBytes: 3.75 * MIB, textBytes: MIB, perMessage: 5, perConversation: 10 } as const

const ALLOWED: ReadonlySet<string> = new Set<MediaType>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'text/markdown',
])

const BY_EXTENSION: Readonly<Record<string, MediaType>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
}

const TEXT: ReadonlySet<string> = new Set<MediaType>(['text/plain', 'text/csv', 'text/markdown'])

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  return dot < 0 || dot === name.length - 1 ? undefined : name.slice(dot + 1).toLowerCase()
}

export function mediaTypeOf(file: { name: string; type: string }): MediaType | undefined {
  const declared = file.type.split(';')[0]!.trim().toLowerCase()
  const extension = extensionOf(file.name)
  const byExtension = extension !== undefined && Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : undefined
  if (!ALLOWED.has(declared)) return byExtension
  if (extension === undefined || byExtension === declared) return declared as MediaType
  return TEXT.has(declared) && (byExtension === undefined || TEXT.has(byExtension)) ? (declared as MediaType) : undefined
}

export type AttachmentReason = 'unsupported_type' | 'too_large' | 'too_many_in_message' | 'too_many_in_conversation' | 'empty'

export type AttachmentCheck = { ok: true; mediaType: MediaType } | { ok: false; reason: AttachmentReason }

function limitOf(mediaType: MediaType): number {
  if (mediaType === 'application/pdf') return ATTACHMENT_LIMITS.pdfBytes
  return mediaType.startsWith('image/') ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.textBytes
}

export function checkAttachment(file: { name: string; type: string; size: number }, already: { inMessage: number; inConversation: number }): AttachmentCheck {
  const mediaType = mediaTypeOf(file)
  if (mediaType === undefined) return { ok: false, reason: 'unsupported_type' }
  if (file.size <= 0) return { ok: false, reason: 'empty' }
  if (file.size > limitOf(mediaType)) return { ok: false, reason: 'too_large' }
  if (already.inMessage >= ATTACHMENT_LIMITS.perMessage) return { ok: false, reason: 'too_many_in_message' }
  if (already.inConversation >= ATTACHMENT_LIMITS.perConversation) return { ok: false, reason: 'too_many_in_conversation' }
  return { ok: true, mediaType }
}

export function attachmentReasonKey(reason: AttachmentReason): MessageKey {
  switch (reason) {
    case 'unsupported_type':
      return 'chat.attach.reason.unsupported_type'
    case 'too_large':
      return 'chat.attach.reason.too_large'
    case 'too_many_in_message':
      return 'chat.attach.reason.too_many_in_message'
    case 'too_many_in_conversation':
      return 'chat.attach.reason.too_many_in_conversation'
    case 'empty':
      return 'chat.attach.reason.empty'
  }
}

const DEFAULT_SHOWN = 48

export function safeName(name: string, max: number = DEFAULT_SHOWN): { shown: string; changed: boolean } {
  if (name.trim() === '') return { shown: '?', changed: true }
  const shown = truncate(markHidden(name), max)
  return { shown, changed: shown !== name }
}
