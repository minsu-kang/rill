import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCatalog } from './build-catalog'

const target = join(import.meta.dirname, '../src/fixtures/catalog.json')
const nodes = buildCatalog()
writeFileSync(target, `${JSON.stringify(nodes, null, 2)}\n`)
console.log(`wrote ${nodes.length} nodes to ${target}`)
process.exit(0)
