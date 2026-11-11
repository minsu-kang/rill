import { FIXTURES_DIR, generateFixtures } from './suites/extract/fixtures'

const manifest = await generateFixtures()
const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
const seedCount = new Set(manifest.files.map((file) => file.seedId)).size
console.log(`generated ${manifest.files.length} files for ${seedCount} seeds in ${FIXTURES_DIR} (${(total / 1024).toFixed(1)} KiB)`)
