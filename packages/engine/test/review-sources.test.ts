import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ENGINE = fileURLToPath(new URL('../src', import.meta.url))
const PLANNER = fileURLToPath(new URL('../../planner/src', import.meta.url))
const REVIEW = join(PLANNER, 'review')

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

function methodBody(name: string): string {
  const body = readFileSync(join(ENGINE, 'engine.ts'), 'utf8')
  const start = body.search(new RegExp(`^ {2}(?:private |async )*${name}\\(`, 'm'))
  expect(start, name).toBeGreaterThanOrEqual(0)
  const rest = body.slice(start + 1)
  const end = rest.search(/^ {2}(?:private |async )*[A-Za-z]\w*\(/m)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('the review can only read and ask the model', () => {
  it('has a reviewPlan that calls no store method that writes, and no method that starts, deploys, activates or saves anything', () => {
    const body = methodBody('reviewPlan')
    expect(body).toMatch(/this\.store\.getPlan\(/)
    expect(body).not.toMatch(/this\.store\.(save|delete|mark|set|create|finish|start|abandon|record|clear|put)\w*\(/)
    expect(body).not.toMatch(/\b(startRun|enqueueRun|deploy|deployPlan|activate|deactivate|deleteWorkflow|saveAgent|deleteAgent|setActiveAgent|saveSkill|deleteSkill|saveRule|deleteRule|saveMemory|deleteMemory|fire|track|plan|cancelPlan)\(/)
    expect(body).not.toMatch(/this\.db\b|\.transaction\(/)
  })

  it('has a resolve step for the reviewer that only reads', () => {
    expect(methodBody('resolveReviewer')).not.toMatch(/this\.store\.(save|delete|mark|set|create)\w*\(|this\.db\b/)
  })

  it('keeps every database, file, network and write path out of the review module of the planner', () => {
    const files = sourceFiles(REVIEW)
    expect(files.length).toBeGreaterThan(3)
    for (const path of files) {
      expect(readFileSync(path, 'utf8'), relative(PLANNER, path)).not.toMatch(
        /node:sqlite|node:fs|node:net|node:http|node:child_process|from '@rill\/engine'|\bfetch\(|\bsaveAgent\b|\bsaveSkill\b|\bsaveRule\b|\bsaveMemory\b|\bdeployPlan\b|\bstartRun\b|\bsetActiveAgent\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/,
      )
    }
  })

  it('calls the provider only through the one generate call of the reviewer', () => {
    const calls = sourceFiles(REVIEW).flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/\.generate\(/g)].map(() => relative(PLANNER, path)))
    expect(calls).toEqual(['review/review.ts'])
  })

  it('has the reviewer of the engine built only in reviewPlan', () => {
    const files = sourceFiles(ENGINE).filter((path) => /createReviewer/.test(readFileSync(path, 'utf8')))
    expect(files.map((path) => relative(ENGINE, path))).toEqual(['engine.ts'])
    const body = readFileSync(join(ENGINE, 'engine.ts'), 'utf8')
    expect([...body.matchAll(/createReviewer\(/g)]).toHaveLength(1)
    expect(methodBody('reviewPlan')).toMatch(/createReviewer\(/)
  })
})
