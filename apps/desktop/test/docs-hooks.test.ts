// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ERROR_CODES,
  HOOK_ACTION_TYPES,
  HOOK_COOLDOWN_MS,
  HOOK_EVENTS,
  HOOK_FAILURE_CODES,
  HOOK_FAILURE_COUNT_MAX,
  HOOK_FAILURE_COUNT_MIN,
  HOOK_LOG_DEFAULT_LIMIT,
  HOOK_LOG_MAX_LIMIT,
  HOOK_LOG_MAX_ROWS,
  HOOK_MAX_ITEMS,
  HOOK_OUTCOMES,
  HOOK_RATE_LIMIT,
  HOOK_RATE_WINDOW_MS,
  HOOK_RULES,
  HOOK_WORKFLOW_LABEL_MAX_CHARS,
  METHODS,
  hookMessage,
} from '@rill/protocol'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function section(text: string, heading: string, level = '##'): string {
  const start = text.indexOf(`\n${heading}\n`)
  if (start === -1) throw new Error(`no section ${heading}`)
  const rest = text.slice(start + heading.length + 2)
  const end = rest.search(new RegExp(`\\n${level} `))
  return end === -1 ? rest : rest.slice(0, end)
}

const engineReadme = read('packages/engine/README.md')
const hooks = section(engineReadme, '## Hook methods')
const security = read('docs/security.md')
const readme = read('README.md')

describe('the hooks section of the engine README', () => {
  it('names the four methods that the protocol has', () => {
    const names = Object.keys(METHODS).filter((name) => /Hook/.test(name))
    expect(names.sort()).toEqual(['deleteHook', 'listHookLog', 'listHooks', 'saveHook'])
    for (const name of names) expect(hooks, name).toContain(`\`${name}\``)
  })

  it('names every event, action, outcome, failure code and problem rule of the code', () => {
    for (const word of [...HOOK_EVENTS, ...HOOK_ACTION_TYPES, ...HOOK_OUTCOMES, ...HOOK_FAILURE_CODES, ...HOOK_RULES]) expect(hooks, word).toContain(word)
  })

  it('names the error codes, and the protocol lists them', () => {
    for (const code of ['HOOK_INVALID', 'HOOK_FULL', 'HOOK_NOT_FOUND']) {
      expect(hooks, code).toContain(`\`${code}\``)
      expect(ERROR_CODES as readonly string[]).toContain(code)
    }
  })

  it('gives the limits that the code has', () => {
    expect(hooks).toContain(`At most ${HOOK_MAX_ITEMS} hooks exist`)
    expect(hooks).toContain(`cooldown of ${HOOK_COOLDOWN_MS / 1000} seconds`)
    expect(hooks).toContain(`${HOOK_RATE_LIMIT} actions in ${HOOK_RATE_WINDOW_MS / 60_000} minutes`)
    expect(hooks).toContain(`newest ${HOOK_LOG_MAX_ROWS} rows`)
    expect(hooks).toContain(`optional \`limit\` (1 to ${HOOK_LOG_MAX_LIMIT}, default ${HOOK_LOG_DEFAULT_LIMIT})`)
    expect(hooks).toContain(`\`count\`, ${HOOK_FAILURE_COUNT_MIN} to ${HOOK_FAILURE_COUNT_MAX}`)
    expect(hooks).toContain(`cut to ${HOOK_WORKFLOW_LABEL_MAX_CHARS} characters`)
    const timeout = /HOOK_POST_TIMEOUT_MS = ([\d_]+)/.exec(read('packages/engine/src/hooks-runner.ts'))![1]!.replaceAll('_', '')
    expect(hooks).toContain(`a post waits at most ${Number(timeout) / 1000} seconds`)
  })

  it('shows the three sentences that hookMessage builds', () => {
    for (const event of HOOK_EVENTS) expect(hooks, event).toContain(`\`${hookMessage(event, 'NAME').replace('NAME', '<name>')}\``)
  })

  it('says which migration creates the tables, and the migration list agrees', () => {
    const entries = read('packages/engine/src/migrations.ts').split(/^ {2}`$/m)
    const number = entries.findIndex((entry) => entry.includes('CREATE TABLE hooks'))
    expect(number).toBeGreaterThan(0)
    expect(entries[number]).toContain('CREATE TABLE hook_log')
    expect(hooks).toContain(`Migration ${number} creates`)
  })

  it('has the table rows for a deleted workflow, and the plan.deployed sentence at deployPlan', () => {
    const deleting = section(engineReadme, '## Deleting a workflow')
    expect(deleting).toMatch(/\| `hooks` \|/)
    expect(deleting).toMatch(/\| `hook_log` \| Kept\./)
    expect(engineReadme).toMatch(/It emits one `plan\.deployed` event `\{ workflowId, planId \}`/)
  })
})

describe('the hooks section of the security notes', () => {
  const part = section(security, '### Hooks', '###')

  it('names the controls and the files that carry them', () => {
    for (const control of ['One write path for hooks', 'A fixed message', 'Rules apply', 'Limits', 'No replay']) expect(part, control).toContain(`| ${control} |`)
    expect(part).toContain('hooks-sources.test.ts')
    expect(part).toContain('notify.slack')
  })

  it('gives the same limits as the code', () => {
    expect(part).toContain(`At most ${HOOK_MAX_ITEMS} hooks`)
    expect(part).toContain(`cooldown of ${HOOK_COOLDOWN_MS / 1000} seconds`)
    expect(part).toContain(`${HOOK_RATE_LIMIT} actions in ${HOOK_RATE_WINDOW_MS / 60_000} minutes`)
    expect(part).toContain(`cut to ${HOOK_WORKFLOW_LABEL_MAX_CHARS} characters`)
  })

  it('lists what hooks do not cover', () => {
    expect(security).toMatch(/- \*\*Hooks act when nobody is watching\.\*\*/)
  })
})

describe('the root README', () => {
  it('lists hooks with their limit and says where the screen is', () => {
    const rows = readme.split('\n').filter((line) => line.startsWith('| Hooks |'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(`Up to ${HOOK_MAX_ITEMS} hooks`)
    expect(rows[0]).toContain(`${HOOK_FAILURE_COUNT_MIN} to ${HOOK_FAILURE_COUNT_MAX} failures in a row`)
    expect(rows[0]).toContain('You edit the hooks on the Agents tab, under Hooks, where an activity list shows what each hook did.')
    expect(rows[0]).not.toMatch(/not built yet/)
  })
})
