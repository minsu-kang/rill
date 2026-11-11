import { ATTACHMENTS_DIR, generateAttachments } from './attachments'
import { loadPlannerData } from './cases'

const manifest = await generateAttachments({ cases: loadPlannerData().cases })
const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
console.log(`generated ${manifest.files.length} planner attachments in ${ATTACHMENTS_DIR} (${(total / 1024).toFixed(1)} KiB)`)
