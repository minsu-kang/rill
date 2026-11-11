import type { AttachmentModule } from '../ports'
import { defaultRandomHex, prepareAttachments, type RandomHex } from './prepare'

export const ATTACHMENT_RULES = ''

export interface AttachmentModuleOptions {
  randomHex?: RandomHex
}

export function createAttachmentModule(options: AttachmentModuleOptions = {}): AttachmentModule {
  const randomHex = options.randomHex ?? defaultRandomHex
  return {
    prepare: (input) => prepareAttachments({ ...input, randomHex }),
    provenance: () => [],
    redactIssues: (issues) => issues,
  }
}

export const attachmentModule: AttachmentModule = createAttachmentModule()

export type { RandomHex }
