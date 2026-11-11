import type { AttachmentModule } from '../ports'
import { defaultRandomHex, prepareAttachments, type RandomHex } from './prepare'
import { UNTRUSTED_SOURCE_TYPES, computeProvenance } from './provenance'
import { redactIssues } from './redact'
import { ATTACHMENT_RULES } from './rules'

export interface AttachmentModuleOptions {
  randomHex?: RandomHex
  untrustedSourceTypes?: ReadonlySet<string>
  resolutionBudget?: number
}

export function createAttachmentModule(options: AttachmentModuleOptions = {}): AttachmentModule {
  const randomHex = options.randomHex ?? defaultRandomHex
  return {
    prepare: (input) => prepareAttachments({ ...input, randomHex }),
    provenance: (input) =>
      computeProvenance(input, {
        ...(options.untrustedSourceTypes === undefined ? {} : { untrustedSourceTypes: options.untrustedSourceTypes }),
        ...(options.resolutionBudget === undefined ? {} : { resolutionBudget: options.resolutionBudget }),
      }),
    redactIssues,
  }
}

export const attachmentModule: AttachmentModule = createAttachmentModule()

export { ATTACHMENT_RULES, UNTRUSTED_SOURCE_TYPES }
export { scrubResultText, type ScrubInput } from './scrub'
export type { RandomHex }
