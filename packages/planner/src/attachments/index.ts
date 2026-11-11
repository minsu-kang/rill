import type { AttachmentModule } from '../ports'
import { defaultRandomHex, prepareAttachments, type RandomHex } from './prepare'
import { UNTRUSTED_SOURCE_TYPES, computeProvenance } from './provenance'
import { redactIssues } from './redact'
import { ATTACHMENT_RULES } from './rules'

export interface AttachmentModuleOptions {
  randomHex?: RandomHex
  untrustedSourceTypes?: ReadonlySet<string>
}

export function createAttachmentModule(options: AttachmentModuleOptions = {}): AttachmentModule {
  const randomHex = options.randomHex ?? defaultRandomHex
  return {
    prepare: (input) => prepareAttachments({ ...input, randomHex }),
    provenance: (input) => computeProvenance(input, { untrustedSourceTypes: options.untrustedSourceTypes }),
    redactIssues,
  }
}

export const attachmentModule: AttachmentModule = createAttachmentModule()

export { ATTACHMENT_RULES, UNTRUSTED_SOURCE_TYPES }
export type { RandomHex }
