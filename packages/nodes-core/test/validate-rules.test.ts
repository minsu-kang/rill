import { readFileSync } from 'node:fs'
import { isWarningIssue, type PlanIssue, type Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import { createCoreRegistry, policyIssues, validateWorkflow, type Policy, type ValidateEnv } from '../src/index'

type Node = Workflow['nodes'][number]

const registry = createCoreRegistry()
const env: ValidateEnv = { registry }

const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({ id, type, config })
const manual = n('t1', 'trigger.manual@1')
const webhook = n('t1', 'trigger.webhook@1', { path: '/hook' })
const chain = (...nodes: Node[]): Workflow => ({
  schemaVersion: 1,
  name: 'wf',
  nodes,
  edges: nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })),
})
const call = (url: string, id = 'n1') => n(id, 'http.request@1', { url })
const policy = (forbiddenNodes: string[] = [], allowedHosts: string[] = []): Policy => ({ forbiddenNodes, allowedHosts })
const rules = (input: unknown, p: Policy, base: ValidateEnv = env) => validateWorkflow(input, { ...base, policy: p }).filter((issue) => issue.code === 'rule_violation')
const brief = (issues: PlanIssue[]) => issues.map((issue) => `${issue.stage} ${issue.code} ${issue.pointer}`)

describe('rule_violation for a forbidden node', () => {
  it('flags a forbidden node at its type, in stage 3, naming the node and the type', () => {
    const issues = rules(chain(manual, call('https://a.com/')), policy(['http.request']))
    expect(brief(issues)).toEqual(['3 rule_violation /nodes/1/type'])
    expect(issues[0]!.message).toContain('n1')
    expect(issues[0]!.message).toContain('http.request')
    expect(issues[0]!.hint).toBeTypeOf('string')
    expect(isWarningIssue(issues[0]!)).toBe(false)
  })

  it('flags every version of the type, also a version that does not exist', () => {
    for (const type of ['http.request@1', 'http.request@2', 'http.request@10']) {
      expect(brief(rules(chain(manual, n('n1', type, { url: 'https://a.com' })), policy(['http.request']))), type).toEqual(['3 rule_violation /nodes/1/type'])
    }
  })

  it('flags every node of that type, in order of position', () => {
    const wf = chain(manual, call('https://a.com/', 'a'), n('b', 'transform@1'), call('https://b.com/', 'c'))
    expect(brief(rules(wf, policy(['http.request'])))).toEqual(['3 rule_violation /nodes/1/type', '3 rule_violation /nodes/3/type'])
  })

  it('does not flag another node type or a type that only starts the same', () => {
    expect(rules(chain(manual, n('n1', 'transform@1')), policy(['http.request']))).toEqual([])
    expect(rules(chain(manual, n('n1', 'notify.slack@1', { connection: 'a', text: 'x' })), policy(['http.request']))).toEqual([])
    expect(rules(chain(manual, n('n1', 'google.sheets.append@1')), policy(['google.sheets']))).toEqual([])
  })

  it('applies to the nodes of Plan 11, to notify.slack and to triggers', () => {
    for (const type of ['google.sheets.append', 'microsoft.excel.append', 'notify.slack', 'csv.append', 'llm.extract', 'condition']) {
      expect(rules(chain(manual, n('n1', `${type}@1`)), policy([type])).map((issue) => issue.pointer), type).toEqual(['/nodes/1/type'])
    }
    expect(rules(chain(manual), policy(['trigger.manual'])).map((issue) => issue.pointer)).toEqual(['/nodes/0/type'])
    expect(rules(chain(n('t1', 'trigger.cron@1', { expression: '0 9 * * *' })), policy(['trigger.cron'])).map((issue) => issue.pointer)).toEqual(['/nodes/0/type'])
  })

  it('compares without regard to case', () => {
    expect(rules(chain(manual, call('https://a.com/')), policy(['HTTP.Request'])).map((issue) => issue.pointer)).toEqual(['/nodes/1/type'])
    expect(rules(chain(n('t1', 'trigger.folderWatch@1', { folder: '/a', glob: '*' })), policy(['trigger.folderwatch'])).map((issue) => issue.pointer)).toEqual(['/nodes/0/type'])
  })

  it('does not touch a node when the list is empty', () => {
    expect(rules(chain(manual, call('https://a.com/')), policy())).toEqual([])
  })
})

describe('rule_violation for a host that is not allowed', () => {
  const allowed = policy([], ['api.example.com', '*.example.org'])

  it('lets an allowed literal URL pass', () => {
    expect(rules(chain(webhook, call('https://api.example.com/v1')), allowed)).toEqual([])
    expect(rules(chain(webhook, call('https://a.example.org/v1')), allowed)).toEqual([])
    expect(rules(chain(webhook, call('https://a.b.example.org/')), allowed)).toEqual([])
  })

  it('flags a host that is not allowed at the url, naming the host, and lists the allowed hosts in the hint', () => {
    const issues = rules(chain(webhook, call('https://evil.com/v1')), allowed)
    expect(brief(issues)).toEqual(['3 rule_violation /nodes/1/config/url'])
    expect(issues[0]!.message).toBe('node n1: the host evil.com is not in the allowed hosts')
    expect(issues[0]!.hint).toBe('allowed hosts: api.example.com, *.example.org')
  })

  it('judges by the real host of the URL', () => {
    for (const url of [
      'https://api.example.com@evil.com/',
      'https://api.example.com.evil.com/',
      'https://evil.com/?h=api.example.com',
      'https://evil.com/#api.example.com',
      'https://example.org/',
      'https://xexample.org/',
    ]) {
      expect(brief(rules(chain(webhook, call(url)), allowed)), url).toEqual(['3 rule_violation /nodes/1/config/url'])
    }
    for (const url of [
      'https://API.EXAMPLE.COM/',
      'https://api.example.com./',
      'https://api.example.com:8443/x',
      'https://user:pw@api.example.com/x#f',
      'https://api.example.com#@evil.com/',
    ]) {
      expect(rules(chain(webhook, call(url)), allowed), url).toEqual([])
    }
  })

  it('says a URL that is a template in its scheme or host part cannot be judged before the run', () => {
    const issues = rules(chain(webhook, call('https://{{t1.output.body.host}}/x')), allowed)
    expect(brief(issues)).toEqual(['3 rule_violation /nodes/1/config/url'])
    expect(issues[0]!.message).toBe('node n1: the host of this URL is only known at run time; with allowed hosts set, write the host into the URL')
    expect(issues[0]!.hint).toBe('allowed hosts: api.example.com, *.example.org')
    for (const url of [
      '{{t1.output.body.url}}',
      'https://api.{{t1.output.body.d}}/x',
      '{{t1.output.body.scheme}}://api.example.com/',
      'https://api.example.com{{t1.output.body.t}}/',
      'https:///{{t1.output.body.t}}.example.org/',
      'https://\\{{t1.output.body.t}}.example.org/',
      'https:////{{t1.output.body.t}}/',
    ]) {
      expect(rules(chain(webhook, call(url)), allowed).map((issue) => issue.message), url).toEqual([issues[0]!.message])
    }
  })

  it('lets a template in the path or the query pass', () => {
    for (const url of ['https://api.example.com/{{t1.output.body.id}}', 'https://api.example.com/x?id={{t1.output.body.id}}']) {
      expect(rules(chain(webhook, call(url)), allowed), url).toEqual([])
    }
  })

  it('says a URL that is not a valid absolute http or https URL cannot be judged', () => {
    for (const url of ['api.example.com/x', 'ftp://api.example.com/', 'https://', 'https://api.example.com:99999/', '//api.example.com/']) {
      const issues = rules(chain(webhook, call(url)), allowed)
      expect(issues.map((issue) => issue.message), url).toEqual(['node n1: the URL is not a valid absolute http or https URL'])
    }
  })

  it('flags each http.request node on its own', () => {
    const wf = chain(webhook, call('https://api.example.com/', 'a'), call('https://evil.com/', 'b'), call('https://{{t1.output.body.h}}/', 'c'))
    expect(brief(rules(wf, allowed))).toEqual(['3 rule_violation /nodes/2/config/url', '3 rule_violation /nodes/3/config/url'])
  })

  it('reports a forbidden http.request once, as a forbidden node', () => {
    const issues = rules(chain(webhook, call('https://evil.com/')), policy(['http.request'], ['api.example.com']))
    expect(brief(issues)).toEqual(['3 rule_violation /nodes/1/type'])
  })

  it('does not apply to notify.slack, google.sheets.append or microsoft.excel.append', () => {
    const wf = chain(
      webhook,
      n('a', 'notify.slack@1', { connection: 'team', text: 'x' }),
      n('b', 'google.sheets.append@1', { connection: 'g', spreadsheetId: 's', range: 'A1', values: ['x'] }),
      n('c', 'microsoft.excel.append@1', { connection: 'm', itemId: 'i', table: 't', values: ['x'] }),
    )
    expect(rules(wf, allowed)).toEqual([])
  })

  it('does nothing when there is no allowed host, whatever the URL is', () => {
    expect(rules(chain(webhook, call('https://evil.com/'), call('{{t1.output.body.u}}', 'n2')), policy(['transform']))).toEqual([])
  })

  it('does not judge a node whose url is missing or not a string; the config check says so', () => {
    const wf = chain(webhook, n('n1', 'http.request@1', {}), n('n2', 'http.request@1', { url: 5 }))
    expect(rules(wf, allowed)).toEqual([])
    expect(validateWorkflow(wf, { ...env, policy: allowed }).some((issue) => issue.code.startsWith('config_'))).toBe(true)
  })

  it('does not run in a stage that was not asked for', () => {
    const wf = chain(webhook, call('https://evil.com/'))
    expect(validateWorkflow(wf, { ...env, policy: policy(['http.request'], ['a.com']), stages: [1, 2] }).filter((issue) => issue.code === 'rule_violation')).toEqual([])
  })

  it('names the allowed hosts, never a path or a query', () => {
    const issues = rules(chain(webhook, call('https://evil.com/secret/path?token=abc')), allowed)
    expect(JSON.stringify(issues)).not.toContain('secret')
    expect(JSON.stringify(issues)).not.toContain('token')
  })
})

describe('policyIssues on its own', () => {
  it('returns the same issues the validator adds', () => {
    const wf = chain(webhook, call('https://evil.com/'), n('n2', 'transform@1'))
    const p = policy(['transform'], ['api.example.com'])
    expect(policyIssues(wf, p)).toEqual(rules(wf, p))
  })

  it('judges only http.request: a url key on another type is not a URL to a host', () => {
    const wf = chain(webhook, n('n1', 'transform@1', { url: 'https://evil.com/' }), n('n2', 'notify.slack@1', { url: 'https://evil.com/' }))
    expect(policyIssues(wf, policy([], ['api.example.com']))).toEqual([])
  })

  it('returns nothing without a policy or with an empty one', () => {
    const wf = chain(webhook, call('https://evil.com/'))
    expect(policyIssues(wf, undefined)).toEqual([])
    expect(policyIssues(wf, policy())).toEqual([])
  })

  it('does not throw on a workflow of the wrong shape', () => {
    expect(policyIssues({ nodes: 'x' } as never, policy(['a'], ['b']))).toEqual([])
    expect(policyIssues({ nodes: [null, 5, {}, { id: 'a', type: 7 }, { id: 'b', type: 'http.request@1' }] } as never, policy(['a'], ['b']))).toEqual([])
  })
})

interface Frozen {
  envs: Record<string, Omit<ValidateEnv, 'registry'>>
  entries: Array<{ name: string; workflow: unknown; results: Record<string, PlanIssue[]> }>
}

const frozen = JSON.parse(readFileSync(new URL('./fixtures/validator-frozen.json', import.meta.url), 'utf8')) as Frozen

describe('with no rule the validator gives exactly the issues it gave before rules existed', () => {
  it('has a corpus of references, recipes and hand-written cases', () => {
    expect(frozen.entries.length).toBeGreaterThan(90)
    expect(frozen.entries.filter((entry) => entry.name.startsWith('reference:')).length).toBe(30)
    expect(frozen.entries.filter((entry) => entry.name.startsWith('recipe:')).length).toBe(6)
    const codes = new Set(frozen.entries.flatMap((entry) => Object.values(entry.results).flatMap((issues) => issues.map((issue) => issue.code))))
    expect(codes.size).toBeGreaterThanOrEqual(20)
    expect(codes.has('rule_violation')).toBe(false)
  })

  const variants: Array<[string, (base: ValidateEnv) => ValidateEnv]> = [
    ['no policy', (base) => base],
    ['an undefined policy', (base) => ({ ...base, policy: undefined })],
    ['an empty policy', (base) => ({ ...base, policy: { forbiddenNodes: [], allowedHosts: [] } })],
  ]

  it.each(variants)('gives byte-identical issues with %s on every entry and environment', (_name, withPolicy) => {
    for (const entry of frozen.entries) {
      for (const [envName, extra] of Object.entries(frozen.envs)) {
        const actual = validateWorkflow(entry.workflow, withPolicy({ registry, ...extra }))
        expect(JSON.stringify(actual), `${entry.name} / ${envName}`).toBe(JSON.stringify(entry.results[envName]))
      }
    }
  })

  it('adds only rule_violation issues when rules are set: every other issue is unchanged', () => {
    const strict = policy(['http.request', 'notify.slack', 'csv.append'], ['only.example.com'])
    let added = 0
    for (const entry of frozen.entries) {
      for (const [envName, extra] of Object.entries(frozen.envs)) {
        const actual = validateWorkflow(entry.workflow, { registry, ...extra, policy: strict })
        added += actual.filter((issue) => issue.code === 'rule_violation').length
        expect(JSON.stringify(actual.filter((issue) => issue.code !== 'rule_violation')), `${entry.name} / ${envName}`).toBe(JSON.stringify(entry.results[envName]))
      }
    }
    expect(added).toBeGreaterThan(20)
  })

  it('flags the reference workflows that use a forbidden node and no other', () => {
    for (const entry of frozen.entries.filter((candidate) => candidate.name.startsWith('reference:'))) {
      const wf = entry.workflow as Workflow
      const uses = wf.nodes.some((node) => node.type.startsWith('http.request@'))
      expect(rules(wf, policy(['http.request'])).length > 0, entry.name).toBe(uses)
    }
  })
})
