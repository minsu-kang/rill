import { generateAttachments } from './attachments'
import { MEMORY_DRAFT_ATTACHMENTS_DIR, loadMemoryDraft } from './memory-draft'

const manifest = await generateAttachments({ outDir: MEMORY_DRAFT_ATTACHMENTS_DIR, cases: loadMemoryDraft().cases })
console.log(`wrote ${manifest.files.length} draft attachment(s) to ${MEMORY_DRAFT_ATTACHMENTS_DIR}`)
