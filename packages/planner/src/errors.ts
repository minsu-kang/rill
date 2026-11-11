import type { AttachmentRef } from './types'

export type AttachmentErrorCode =
  | 'not_found'
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'type_mismatch'
  | 'closing_tag_in_content'

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode
  readonly ref: AttachmentRef

  constructor(code: AttachmentErrorCode, ref: AttachmentRef, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.code = code
    this.ref = ref
  }
}
