import type { AttachmentModule } from '../ports'

export const ATTACHMENT_RULES = ''

export const attachmentModule: AttachmentModule = {
  async prepare({ refs }) {
    if (refs.length > 0) throw new Error('attachments are not wired yet')
    return { parts: [], texts: [] }
  },
  provenance: () => [],
  redactIssues: (issues) => issues,
}
