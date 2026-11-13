import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ENGINE = fileURLToPath(new URL('../src', import.meta.url))
const PLANNER = fileURLToPath(new URL('../../planner/src', import.meta.url))
const PROTOCOL = fileURLToPath(new URL('../../protocol/src', import.meta.url))

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

const METHOD = /^ {2}(?:(?:private|public|protected|static|async|readonly) )*([A-Za-z_]\w*)\(/
const FUNCTION = /^(?:export )?(?:async )?function (\w+)/

function sitesOf(path: string, pattern: RegExp): Array<{ line: number; owner: string }> {
  const sites: Array<{ line: number; owner: string }> = []
  let owner = ''
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      const method = METHOD.exec(text)?.[1] ?? FUNCTION.exec(text)?.[1]
      if (method !== undefined) owner = method
      if (pattern.test(text)) sites.push({ line: index + 1, owner })
    })
  return sites
}

function found(roots: string[], pattern: RegExp): string[] {
  return roots.flatMap((root) => sourceFiles(root).flatMap((path) => sitesOf(path, pattern).map((site) => `${relative(root, path)}:${site.owner}`)))
}

const WRITE = String.raw`(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE)\s+`

describe('only saveSkill and deleteSkill write the skills table', () => {
  it('has no writer of skills in the engine or the planner except the two store methods and the migration', () => {
    expect(found([ENGINE, PLANNER], new RegExp(`${WRITE}skills\\b`, 'i')).sort()).toEqual(['store.ts:deleteSkill', 'store.ts:saveSkill', 'store.ts:saveSkill'].sort())
  })

  it('writes the skill_ids column of agents only in saveAgent and deleteSkill', () => {
    expect(found([ENGINE, PLANNER], /\bskill_ids\b.*=\s*\?|\bskill_ids\b.*VALUES|INSERT INTO agents/i).sort()).toEqual(['store.ts:deleteSkill', 'store.ts:saveAgent', 'store.ts:saveAgent'].sort())
  })

  it('mentions the skills table only in the migration and the store', () => {
    const files = [ENGINE, PLANNER].flatMap((root) => sourceFiles(root).filter((path) => /\bFROM skills\b|\bINTO skills\b|\bUPDATE skills\b/.test(readFileSync(path, 'utf8'))).map((path) => relative(root, path)))
    expect(files.sort()).toEqual(['store.ts'])
  })

  it('keeps every line that mentions the skills table inside the store methods that read or write skills', () => {
    const owners = new Set(sitesOf(join(ENGINE, 'store.ts'), /\bFROM skills\b|\bINTO skills\b|\bUPDATE skills\b/).map((site) => site.owner))
    expect([...owners].sort()).toEqual(['deleteSkill', 'listSkills', 'saveSkill', 'skillsOf'].sort())
  })

  it('calls the writing methods only from the engine methods, the store methods and the server handlers', () => {
    expect(found([ENGINE, PLANNER], /\.(saveSkill|deleteSkill)\(/).sort()).toEqual(['engine.ts:deleteSkill', 'engine.ts:saveSkill', 'server/server.ts:createHandlers', 'server/server.ts:createHandlers'].sort())
  })

  it('has no skill write call inside plan, runPlan, deployPlan, getPlan, listPlans, cancelPlan, explainRun or resolveAgent', () => {
    const body = readFileSync(join(ENGINE, 'engine.ts'), 'utf8')
    for (const name of ['plan', 'runPlan', 'deployPlan', 'getPlan', 'listPlans', 'cancelPlan', 'explainRun', 'resolveAgent']) {
      const start = body.search(new RegExp(`^ {2}(?:private |async )*${name}\\(`, 'm'))
      expect(start, name).toBeGreaterThanOrEqual(0)
      const rest = body.slice(start + 1)
      const end = rest.search(/^ {2}(?:private |async )*[A-Za-z]\w*\(/m)
      const method = rest.slice(0, end === -1 ? undefined : end)
      expect(method, name).not.toMatch(/saveSkill|deleteSkill|saveAgent|deleteAgent|setActiveAgent|skills\b.*(INSERT|UPDATE|DELETE)/)
    }
  })

  it('keeps every database and write path out of the planner package', () => {
    for (const path of sourceFiles(PLANNER)) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/\bsaveSkill\b|\bdeleteSkill\b|\blistSkills\b|\bskill_ids\b|\bFROM skills\b|node:sqlite|from '@rill\/engine'/)
    }
  })

  it('has no way to save a skill from the protocol client other than the three methods', () => {
    const methods = readFileSync(join(PROTOCOL, 'methods.ts'), 'utf8')
    expect([...methods.matchAll(/^ {2}(\w*Skill\w*): \{/gm)].map((match) => match[1]).sort()).toEqual(['deleteSkill', 'listSkills', 'saveSkill'])
  })
})
