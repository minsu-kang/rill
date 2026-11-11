import type { AttachmentModule } from '../ports'
import { defaultRandomHex, prepareAttachments, type RandomHex } from './prepare'
import { UNTRUSTED_SOURCE_TYPES, computeProvenance } from './provenance'

export const ATTACHMENT_RULES = ''

export interface AttachmentModuleOptions {
  randomHex?: RandomHex
  untrustedSourceTypes?: ReadonlySet<string>
}

export function createAttachmentModule(options: AttachmentModuleOptions = {}): AttachmentModule {
  const randomHex = options.randomHex ?? defaultRandomHex
  return {
    prepare: (input) => prepareAttachments({ ...input, randomHex }),
    provenance: (input) => computeProvenance(input, { untrustedSourceTypes: options.untrustedSourceTypes }),
    redactIssues: (issues) => issues,
  }
}

export const attachmentModule: AttachmentModule = createAttachmentModule()

export { UNTRUSTED_SOURCE_TYPES }
export type { RandomHex }
