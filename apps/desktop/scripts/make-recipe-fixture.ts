import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRecipeFixture } from './build-recipe-fixture'

const target = join(import.meta.dirname, '../src/fixtures/recipe-infos.json')
const fixture = buildRecipeFixture()
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${fixture.recipes.length} recipes and ${Object.keys(fixture.drafts).length} drafts to ${target}`)
process.exit(0)
