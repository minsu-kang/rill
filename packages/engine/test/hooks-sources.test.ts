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

describe('only saveHook, deleteHook and the delete of a workflow write the hooks table', () => {
  it('has no writer of hooks in the engine or the planner except those store methods', () => {
    expect(found([ENGINE, PLANNER], new RegExp(`${WRITE}hooks\\b`, 'i')).sort()).toEqual(
      ['store.ts:deleteHook', 'store.ts:deleteWorkflow', 'store.ts:saveHook', 'store.ts:saveHook'].sort(),
    )
  })

  it('has no writer of the hook log except the store method that appends and prunes it', () => {
    expect(found([ENGINE, PLANNER], new RegExp(`${WRITE}hook_log\\b`, 'i')).sort()).toEqual(['store.ts:appendHookLog', 'store.ts:appendHookLog'].sort())
  })

  it('mentions the tables only in the migration and the store', () => {
    const files = [ENGINE, PLANNER].flatMap((root) =>
      sourceFiles(root)
        .filter((path) => /\bFROM hooks\b|\bINTO hooks\b|\bUPDATE hooks\b|\bhook_log\b/.test(readFileSync(path, 'utf8')))
        .map((path) => relative(root, path)),
    )
    expect(files.sort()).toEqual(['migrations.ts', 'store.ts'])
  })

  it('calls the writing methods only from the engine methods and the server handlers, and the log writer only from the runner', () => {
    expect(found([ENGINE, PLANNER], /\.(saveHook|deleteHook)\(/).sort()).toEqual(
      ['engine.ts:deleteHook', 'engine.ts:saveHook', 'server/server.ts:createHandlers', 'server/server.ts:createHandlers'].sort(),
    )
    expect(found([ENGINE, PLANNER], /\.appendHookLog\(/)).toEqual(['hooks-runner.ts:execute'])
  })

  it('has no hook write inside plan, runPlan, deployPlan, explainRun, startRun or the other ways a workflow or a plan comes to be', () => {
    const body = readFileSync(join(ENGINE, 'engine.ts'), 'utf8')
    for (const name of ['plan', 'runPlan', 'deployPlan', 'getPlan', 'listPlans', 'explainRun', 'deploy', 'instantiateRecipe', 'enqueueRun', 'startRun', 'activate', 'deactivate']) {
      const start = body.search(new RegExp(`^ {2}(?:private |async )*${name}\\(`, 'm'))
      expect(start, name).toBeGreaterThanOrEqual(0)
      const rest = body.slice(start + 1)
      const end = rest.search(/^ {2}(?:private |async )*[A-Za-z]\w*\(/m)
      const method = rest.slice(0, end === -1 ? undefined : end)
      expect(method, name).not.toMatch(/saveHook|deleteHook|appendHookLog|hook_log|\bhooks\b/)
    }
  })

  it('keeps every database and write path for hooks out of the planner package', () => {
    for (const path of sourceFiles(PLANNER)) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/\bsaveHook\b|\bdeleteHook\b|\blistHooks\b|\blistHookLog\b|\bappendHookLog\b|\bhook_log\b/)
    }
  })

  it('has no way to change a hook from the protocol other than the three methods, and one to read the log', () => {
    const methods = readFileSync(join(PROTOCOL, 'methods.ts'), 'utf8')
    expect([...methods.matchAll(/^ {2}(\w*Hook\w*): \{/gm)].map((match) => match[1]).sort()).toEqual(['deleteHook', 'listHookLog', 'listHooks', 'saveHook'])
  })
})

describe('the hook runner has no way to cause a run, a plan, a deploy or a model call', () => {
  const source = readFileSync(join(ENGINE, 'hooks-runner.ts'), 'utf8')

  it('imports only the Slack post, the protocol, the events, the hook helpers and the store', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort()
    expect(imports).toEqual(['./events', './hooks', './store', '@rill/nodes-core', '@rill/protocol'])
  })

  it('names nothing that starts or stores a run, a plan, a workflow or a model call', () => {
    expect(source).not.toMatch(/enqueueRun|startRun|\bfire\b|createRun|createTriggeredRun|saveWorkflow|savePlan|markPlanDeployed|deployPlan|\bdeploy\b|\bplan\(|explainRun|\bllm\b|LlmProvider|\.generate\(|\bactivate\(/)
  })

  it('takes one way to act on the engine: switching a workflow off', () => {
    const deps = /export interface HookRunnerDeps \{([\s\S]*?)\n\}/.exec(source)![1]!
    expect([...deps.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]).sort()).toEqual(['connections', 'deactivate', 'forbiddenNodes', 'store', 'timeoutMs'])
  })

  it('writes to the store through the log method only', () => {
    expect([...source.matchAll(/store\.(\w+)\(/g)].map((match) => match[1]).sort()).toEqual(
      ['appendHookLog', 'getRunSummary', 'hookExecutionsSince', 'isWorkflowActive', 'lastHookExecution', 'listHooks', 'recentNonDryRuns', 'workflowName'].sort(),
    )
  })
})
